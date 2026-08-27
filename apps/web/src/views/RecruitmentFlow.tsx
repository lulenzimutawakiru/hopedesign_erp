import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, getToken } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

const ATS_STAGES = ['SUBMITTED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'ASSESSMENT', 'REFERENCE_CHECK', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'];

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

function nextStages(current: string): string[] {
  const i = ATS_STAGES.indexOf(current);
  const from = i >= 0 ? i + 1 : 1;
  return ATS_STAGES.slice(from).filter((s) => s !== 'WITHDRAWN');
}

function salaryRange(r: Rec): string {
  const min = Number(r.salaryMin ?? 0);
  const max = Number(r.salaryMax ?? 0);
  if (!min && !max) return '-';
  return `${fmtMoney(min)} - ${fmtMoney(max)} ${String(r.currency ?? 'UGX')}`;
}

function allowancesText(v: unknown): string {
  const o = parseJson<Record<string, unknown>>(v, {});
  const parts = Object.entries(o).map(([k, val]) => `${k}: ${fmtMoney(val)}`);
  return parts.length ? parts.join(', ') : '-';
}

export default function RecruitmentFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const view = parts[1] ?? 'recruitment';
  const id = parts[2] ?? null;
  if (view === 'requisitions' && id === 'new') return <RequisitionComposer />;
  if (view === 'requisitions') return <RequisitionList />;
  if (view === 'vacancies' && id === 'new') return <VacancyComposer />;
  if (view === 'vacancies') return <VacancyList />;
  if (view === 'candidates' && id) return <CandidateDesk id={Number(id)} />;
  if (view === 'candidates') return <CandidateList />;
  return <Pipeline />;
}

function RequisitionList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/hr/requisitions?pageSize=100')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Requisitions failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments')
      .then((r) => setDepts(r.data ?? []))
      .catch(() => undefined);
  }, []);
  const deptName = (id: unknown) => {
    const d = depts.find((x) => Number(x.id) === Number(id));
    return d ? String(d.name ?? '-') : '-';
  };
  const act = async (row: Rec, action: 'submit' | 'vacancy') => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'vacancy') {
        navigate('/people/vacancies/new', { query: { requisitionId: Number(row.id) } });
        return;
      }
      await api<{ data: Rec }>(`/api/ops/hcm/requisitions/${String(row.id)}/submit`, { method: 'POST' });
      setNotice(`Requisition ${String(row.requisitionNo ?? '')} submitted for approval`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>Job requisitions</h1>
          <p className="muted">Requests to hire. Submit for approval, then turn approved requisitions into vacancies.</p>
        </div>
        {can(user, 'hr.requisitions.create') && (
          <button className="btn btn-primary" onClick={() => navigate('/people/requisitions/new')}>New requisition</button>
        )}
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>No</th><th>Title</th><th>Department</th><th className="cell-num">Headcount</th><th>Salary range</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.requisitionNo ?? '-')}</td>
                <td>{String(r.title ?? '-')}</td>
                <td>{deptName(r.departmentId)}</td>
                <td className="cell-num">{fmtNum(r.headcount)}</td>
                <td>{salaryRange(r)}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions">
                    {can(user, 'hr.requisitions.submit') && String(r.status) === 'DRAFT' && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => act(r, 'submit')}>Submit</button>
                    )}
                    {can(user, 'hr.vacancies.create') && String(r.status) === 'APPROVED' && (
                      <button className="btn btn-sm" onClick={() => act(r, 'vacancy')}>Create vacancy</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7}><p className="muted" style={{ padding: 12 }}>No requisitions yet.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function RequisitionComposer() {
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [employmentType, setEmploymentType] = useState('PERMANENT');
  const [headcount, setHeadcount] = useState('1');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [budgetCode, setBudgetCode] = useState('');
  const [experienceYears, setExperienceYears] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [requiredQualifications, setRequiredQualifications] = useState('');
  const [requiredSkills, setRequiredSkills] = useState('');
  const [justification, setJustification] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [isReplacement, setIsReplacement] = useState(false);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments').then((r) => setDepts(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/positions').then((r) => setPositions(r.data ?? [])).catch(() => undefined);
  }, []);
  const payload = (): Rec => ({
    title: title.trim(),
    departmentId: departmentId ? Number(departmentId) : undefined,
    positionId: positionId ? Number(positionId) : undefined,
    employmentType,
    headcount: headcount ? Number(headcount) : undefined,
    salaryMin: salaryMin ? Number(salaryMin) : undefined,
    salaryMax: salaryMax ? Number(salaryMax) : undefined,
    currency: currency.trim() || undefined,
    budgetCode: budgetCode.trim() || undefined,
    experienceYears: experienceYears ? Number(experienceYears) : undefined,
    requiredDate: requiredDate || undefined,
    requiredQualifications: requiredQualifications.trim() || undefined,
    requiredSkills: requiredSkills.trim() ? requiredSkills.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    justification: justification.trim() || undefined,
    jobDescription: jobDescription.trim() || undefined,
    isReplacement: isReplacement || undefined,
  });
  const save = async (submit: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { requisitionId: number; requisitionNo: string } }>('/api/ops/hcm/requisitions', {
        method: 'POST',
        body: JSON.stringify(payload()),
      });
      if (submit) {
        await api<{ data: Rec }>(`/api/ops/hcm/requisitions/${r.data.requisitionId}/submit`, { method: 'POST' });
      }
      navigate('/people/requisitions');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/requisitions')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>New job requisition</h1>
          <p className="muted">Requested headcount, role and budget. Needs approval before a vacancy can be created.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title *</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label>Department</label><select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">-</option>{depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name ?? '')}</option>)}</select></div>
          <div className="field"><label>Position</label><select value={positionId} onChange={(e) => setPositionId(e.target.value)}><option value="">-</option>{positions.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.title ?? '')}</option>)}</select></div>
          <div className="field"><label>Employment type</label><select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>{['PERMANENT', 'CONTRACT', 'PART_TIME', 'CASUAL', 'INTERNSHIP'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
          <div className="field"><label>Headcount</label><input inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} /></div>
          <div className="field"><label>Salary min</label><input inputMode="decimal" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} /></div>
          <div className="field"><label>Salary max</label><input inputMode="decimal" value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} /></div>
          <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
          <div className="field"><label>Budget code</label><input value={budgetCode} onChange={(e) => setBudgetCode(e.target.value)} /></div>
          <div className="field"><label>Experience (years)</label><input inputMode="numeric" value={experienceYears} onChange={(e) => setExperienceYears(e.target.value)} /></div>
          <div className="field"><label>Required date</label><input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Required qualifications</label><textarea rows={2} value={requiredQualifications} onChange={(e) => setRequiredQualifications(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Required skills (comma separated)</label><input value={requiredSkills} onChange={(e) => setRequiredSkills(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Justification</label><textarea rows={2} value={justification} onChange={(e) => setJustification(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Job description</label><textarea rows={3} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} /></div>
          <label className="check-row"><input type="checkbox" checked={isReplacement} onChange={(e) => setIsReplacement(e.target.checked)} /> Replacement for an existing position</label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="btn" disabled={busy} onClick={() => save(true)}>Save and submit</button>
        </div>
      </section>
    </div>
  );
}
function VacancyList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [publishId, setPublishId] = useState<number | null>(null);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/vacancies/pipeline')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Vacancies failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>Vacancies</h1>
          <p className="muted">Published openings and their applicant counts.</p>
        </div>
        {can(user, 'hr.vacancies.create') && (
          <button className="btn btn-primary" onClick={() => navigate('/people/vacancies/new')}>New vacancy</button>
        )}
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>No</th><th>Title</th><th>Requisition</th><th className="cell-num">Openings</th><th className="cell-num">Filled</th><th className="cell-num">Applications</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.vacancyNo ?? '-')}</td>
                <td><button className="row-click" onClick={() => navigate('/people/recruitment', { query: { vacancyId: Number(r.id) } })}>{String(r.title ?? '-')}</button></td>
                <td className="cell-mono">{String(r.requisitionNo ?? '-')}</td>
                <td className="cell-num">{fmtNum(r.openings)}</td>
                <td className="cell-num">{fmtNum(r.filled)}</td>
                <td className="cell-num">{fmtNum(r.totalApplications)}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions">
                    {can(user, 'hr.vacancies.publish') && String(r.status) === 'DRAFT' && (
                      <button className="btn btn-sm" onClick={() => setPublishId(Number(r.id))}>Publish</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8}><p className="muted" style={{ padding: 12 }}>No vacancies yet.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {publishId !== null && (
        <PublishModal
          vacancyId={publishId}
          onClose={() => setPublishId(null)}
          onDone={() => { setPublishId(null); setNotice('Vacancy published'); load(); }}
        />
      )}
    </div>
  );
}

function PublishModal({ vacancyId, onClose, onDone }: { vacancyId: number; onClose: () => void; onDone: () => void }) {
  const [closesAt, setClosesAt] = useState('');
  const [channels, setChannels] = useState<{ channelType: string; provider: string; url: string }[]>([
    { channelType: 'INTERNAL_PORTAL', provider: '', url: '' },
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setChannel = (i: number, k: 'channelType' | 'provider' | 'url', v: string) => {
    setChannels((prev) => prev.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  };
  const publish = async () => {
    setBusy(true); setError('');
    try {
      const payload: Rec = {};
      if (closesAt) payload.closesAt = closesAt;
      const used = channels
        .filter((c) => c.channelType)
        .map((c) => ({ channelType: c.channelType, provider: c.provider || undefined, url: c.url || undefined }));
      if (used.length) payload.channels = used;
      await api<{ data: Rec }>(`/api/ops/hcm/vacancies/${vacancyId}/publish`, { method: 'POST', body: JSON.stringify(payload) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal
      title="Publish vacancy"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={publish}>Publish</button>
        </div>
      }
    >
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field"><label>Closes at</label><input type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></div>
      </div>
      <p className="muted" style={{ margin: '8px 0 4px' }}>Channels (leave the list empty to use the default internal and external portals)</p>
      {channels.map((c, i) => (
        <div key={i} className="form-grid" style={{ marginBottom: 8 }}>
          <div className="field"><label>Channel</label><select value={c.channelType} onChange={(e) => setChannel(i, 'channelType', e.target.value)}>{['INTERNAL_PORTAL', 'EXTERNAL_PORTAL', 'JOB_BOARD', 'LINKEDIN', 'REFERRAL', 'AGENCY', 'SOCIAL', 'OTHER'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
          <div className="field"><label>Provider</label><input value={c.provider} onChange={(e) => setChannel(i, 'provider', e.target.value)} /></div>
          <div className="field"><label>URL</label><input value={c.url} onChange={(e) => setChannel(i, 'url', e.target.value)} /></div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
            <button className="btn btn-sm" onClick={() => setChannels((prev) => prev.filter((_, j) => j !== i))}>Remove</button>
          </div>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setChannels((prev) => [...prev, { channelType: 'JOB_BOARD', provider: '', url: '' }])}>Add channel</button>
    </Modal>
  );
}
function VacancyComposer() {
  const query = useHashQuery();
  const [requisitions, setRequisitions] = useState<Rec[]>([]);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [requisitionId, setRequisitionId] = useState(query.get('requisitionId') ?? '');
  const [positionId, setPositionId] = useState('');
  const [title, setTitle] = useState('');
  const [openings, setOpenings] = useState('1');
  const [closesAt, setClosesAt] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [isInternal, setIsInternal] = useState(true);
  const [isExternal, setIsExternal] = useState(true);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/hr/requisitions?pageSize=200&status=APPROVED').then((r) => setRequisitions(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/positions').then((r) => setPositions(r.data ?? [])).catch(() => undefined);
  }, []);
  const save = async () => {
    if (!requisitionId) { setError('An approved requisition is required'); return; }
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/vacancies', {
        method: 'POST',
        body: JSON.stringify({
          requisitionId: Number(requisitionId),
          positionId: positionId ? Number(positionId) : undefined,
          title: title.trim() || undefined,
          openings: openings ? Number(openings) : undefined,
          closesAt: closesAt || undefined,
          externalUrl: externalUrl.trim() || undefined,
          applyUrl: applyUrl.trim() || undefined,
          isInternal: isInternal || undefined,
          isExternal: isExternal || undefined,
          description: description.trim() || undefined,
        }),
      });
      navigate('/people/vacancies');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/vacancies')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>New vacancy</h1>
          <p className="muted">Created from an approved requisition. Publish it to open applications.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field"><label>Requisition (approved) *</label><select value={requisitionId} onChange={(e) => setRequisitionId(e.target.value)}><option value="">-</option>{requisitions.map((r) => <option key={String(r.id)} value={String(r.id)}>{String(r.requisitionNo ?? '')} - {String(r.title ?? '')}</option>)}</select></div>
          <div className="field"><label>Position</label><select value={positionId} onChange={(e) => setPositionId(e.target.value)}><option value="">-</option>{positions.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.title ?? '')}</option>)}</select></div>
          <div className="field"><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to requisition title" /></div>
          <div className="field"><label>Openings</label><input inputMode="numeric" value={openings} onChange={(e) => setOpenings(e.target.value)} /></div>
          <div className="field"><label>Closes at</label><input type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></div>
          <div className="field"><label>External URL</label><input value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} /></div>
          <div className="field"><label>Apply URL</label><input value={applyUrl} onChange={(e) => setApplyUrl(e.target.value)} /></div>
          <label className="check-row"><input type="checkbox" checked={isInternal} onChange={(e) => setIsInternal(e.target.checked)} /> Internal portal</label>
          <label className="check-row"><input type="checkbox" checked={isExternal} onChange={(e) => setIsExternal(e.target.checked)} /> External portal</label>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Create vacancy</button>
      </section>
    </div>
  );
}
function Pipeline() {
  const { user } = useAuth();
  const [columns, setColumns] = useState<Rec[]>([]);
  const [vacancies, setVacancies] = useState<Rec[]>([]);
  const [vacancyId, setVacancyId] = useState('');
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [error, setError] = useState('');
  const [showApply, setShowApply] = useState(false);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (vacancyId) params.set('vacancyId', vacancyId);
    if (appliedQ.trim()) params.set('q', appliedQ.trim());
    const qs = params.toString();
    api<{ data: Rec[] }>(`/api/ops/hcm/applications/pipeline${qs ? `?${qs}` : ''}`)
      .then((r) => setColumns(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Pipeline failed'));
  }, [vacancyId, appliedQ]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/vacancies/pipeline')
      .then((r) => setVacancies(r.data ?? []))
      .catch(() => undefined);
  }, []);
  if (error && columns.length === 0) return <ErrorBanner error={error} />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>Application pipeline</h1>
          <p className="muted">Every stage transition is logged. Open a card to move, interview, assess or offer.</p>
        </div>
        {can(user, 'hr.applications.create') && (
          <button className="btn btn-primary" onClick={() => setShowApply(true)}>Add application</button>
        )}
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="form-grid" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>Vacancy</label>
            <select value={vacancyId} onChange={(e) => setVacancyId(e.target.value)}>
              <option value="">All vacancies</option>
              {vacancies.map((v) => <option key={String(v.id)} value={String(v.id)}>{String(v.vacancyNo ?? '')} - {String(v.title ?? '')}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Search</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Candidate name, email, title" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setAppliedQ(q)}>Apply</button>
            <button className="btn btn-sm" onClick={() => { setVacancyId(''); setQ(''); setAppliedQ(''); }}>Reset</button>
          </div>
        </div>
      </section>
      {columns.length === 0 ? (
        <PageLoader label="Opening pipeline..." />
      ) : (
        <div className="pipe">
          {columns.map((col) => {
            const apps = (col.applications as Rec[]) ?? [];
            return (
              <div key={String(col.stage)} className="pipe-col">
                <header>
                  <strong>{String(col.stage ?? '').replace(/_/g, ' ')}</strong>
                  <span className="muted">{String(col.count ?? apps.length)}</span>
                </header>
                {apps.map((a) => (
                  <button key={String(a.id)} className="pipe-card" onClick={() => navigate(`/people/candidates/${String(a.candidateId)}`)}>
                    <strong>{String(a.firstName ?? '')} {String(a.lastName ?? '')}</strong>
                    {a.currentTitle ? <span className="muted">{String(a.currentTitle)}</span> : null}
                    <span className="cell-mono">{String(a.vacancyNo ?? '')}{a.currentRating !== null && a.currentRating !== undefined ? `  rating ${String(a.currentRating)}` : ''}</span>
                  </button>
                ))}
                {apps.length === 0 && <p className="muted" style={{ padding: '8px 4px' }}>Empty</p>}
              </div>
            );
          })}
        </div>
      )}
      {showApply && <ApplyModal onClose={() => setShowApply(false)} onDone={() => { setShowApply(false); load(); }} />}
    </div>
  );
}

function ApplyModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [vacancies, setVacancies] = useState<Rec[]>([]);
  const [vid, setVid] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('MANUAL');
  const [currentEmployer, setCurrentEmployer] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [expectedSalary, setExpectedSalary] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [noticePeriodDays, setNoticePeriodDays] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/vacancies/pipeline')
      .then((r) => setVacancies(r.data ?? []))
      .catch(() => undefined);
  }, []);
  const save = async () => {
    if (!vid) { setError('Select a vacancy'); return; }
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required'); return; }
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/applications', {
        method: 'POST',
        body: JSON.stringify({
          vacancyId: Number(vid),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          source,
          currentEmployer: currentEmployer.trim() || undefined,
          currentTitle: currentTitle.trim() || undefined,
          expectedSalary: expectedSalary ? Number(expectedSalary) : undefined,
          currency: currency || undefined,
          noticePeriodDays: noticePeriodDays ? Number(noticePeriodDays) : undefined,
          coverLetter: coverLetter.trim() || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Add application" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Create application</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Vacancy *</label>
          <select value={vid} onChange={(e) => setVid(e.target.value)}>
            <option value="">Select vacancy</option>
            {vacancies.map((v) => <option key={String(v.id)} value={String(v.id)}>{String(v.vacancyNo ?? '')} - {String(v.title ?? '')}</option>)}
          </select>
        </div>
        <div className="field"><label>First name *</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
        <div className="field"><label>Last name *</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
        <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div className="field">
          <label>Source</label>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {['MANUAL', 'JOB_PORTAL', 'REFERRAL', 'LINKEDIN', 'AGENCY', 'WALK_IN', 'CAREER_SITE'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Current employer</label><input value={currentEmployer} onChange={(e) => setCurrentEmployer(e.target.value)} /></div>
        <div className="field"><label>Current title</label><input value={currentTitle} onChange={(e) => setCurrentTitle(e.target.value)} /></div>
        <div className="field"><label>Expected salary</label><input inputMode="decimal" value={expectedSalary} onChange={(e) => setExpectedSalary(e.target.value)} /></div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
        <div className="field"><label>Notice period (days)</label><input inputMode="numeric" value={noticePeriodDays} onChange={(e) => setNoticePeriodDays(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Cover letter</label><textarea rows={4} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} /></div>
      </div>
    </Modal>
  );
}
function CandidateList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/hr/candidates?pageSize=100')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Candidates failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>Candidates</h1>
          <p className="muted">Every application links back to a candidate record. Open a row for the full candidate desk.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Current title</th>
              <th>Source</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/candidates/${String(r.id)}`)}>
                <td><strong>{String(r.firstName ?? '')} {String(r.lastName ?? '')}</strong></td>
                <td className="muted">{String(r.email ?? '')}{r.phone ? ` | ${String(r.phone)}` : ''}</td>
                <td>{String(r.currentTitle ?? '-')}</td>
                <td><Badge value={r.source} /></td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No candidates found.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
type CandidateDoc = { candidate: Rec; applications: Rec[]; interviews: Rec[]; assessments: Rec[]; offers: Rec[]; documents: Rec[] };

function CandidateDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<CandidateDoc | null>(null);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [onboard, setOnboard] = useState<Rec | null>(null);
  const [advanceApp, setAdvanceApp] = useState<Rec | null>(null);
  const [interviewApp, setInterviewApp] = useState<Rec | null>(null);
  const [assessApp, setAssessApp] = useState<Rec | null>(null);
  const [offerApp, setOfferApp] = useState<Rec | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const load = useCallback(() => {
    api<{ data: CandidateDoc }>(`/api/ops/hcm/candidates/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Candidate failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/positions').then((r) => setPositions(r.data ?? [])).catch(() => undefined);
  }, []);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening candidate..." />;
  const c = doc.candidate;
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data && r.data.onboardingInstanceId) setOnboard(r.data);
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const appNo = (applicationId: unknown) => {
    const a = doc.applications.find((x) => Number(x.id) === Number(applicationId));
    return a ? String(a.applicationNo ?? '') : '-';
  };
  const appOpen = (a: Rec) => !['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(String(a.status ?? ''));
  const acceptOffer = (o: Rec) => {
    const startDate = window.prompt('Start date (YYYY-MM-DD)');
    if (startDate === null) return;
    if (!startDate.trim()) { setError('Start date is required'); return; }
    act(`/api/ops/hcm/offers/${String(o.id)}/accept`, { startDate: startDate.trim() }, 'Offer accepted');
  };
  const declineOffer = (o: Rec) => {
    const reason = window.prompt('Reason for declining (optional)');
    if (reason === null) return;
    act(`/api/ops/hcm/offers/${String(o.id)}/decline`, { reason: reason.trim() || undefined }, 'Offer declined');
  };
  const downloadDocument = async (d: Rec) => {
    setError('');
    try {
      const token = getToken();
      const res = await fetch(`/api/ops/hcm/candidates/${id}/documents/${String(d.id)}/file?download=1`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = String(d.fileName ?? `document-${String(d.id)}.pdf`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/candidates')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Recruitment</p>
          <h1>{String(c.firstName ?? '')} {String(c.lastName ?? '')}</h1>
          <p className="muted">{String(c.currentTitle ?? '')}{c.currentEmployer ? ` at ${String(c.currentEmployer)}` : ''}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <Badge value={c.status} />
            <Badge value={c.source} />
            {c.email ? <Badge value={c.email} /> : null}
            {c.phone ? <Badge value={c.phone} /> : null}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {can(user, 'hr.candidates.update') && (
            <button className="btn btn-sm" onClick={() => setShowUpload(true)}>Upload document</button>
          )}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {onboard ? (
        <section className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Offer accepted - onboarding</h3></div>
          <p className="muted">
            Employee {String(onboard.employeeNo ?? '')}{onboard.startDate ? ` starts ${fmtDate(String(onboard.startDate))}` : ''}. Start the onboarding case to create the employee workspace and checklist.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {can(user, 'hr.onboarding.start') && (
              <button className="btn btn-primary" disabled={busy}
                onClick={() => act(`/api/ops/hcm/onboarding/${String(onboard.onboardingInstanceId)}/start`, {}, 'Onboarding started')}>
                Start onboarding
              </button>
            )}
            {can(user, 'hr.onboarding.view') && (
              <button className="btn" onClick={() => navigate(`/records/hr/onboarding/${String(onboard.onboardingInstanceId)}`)}>
                Open onboarding
              </button>
            )}
          </div>
        </section>
      ) : null}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Applications</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Application</th>
                <th>Vacancy</th>
                <th>Status</th>
                <th>Expected salary</th>
                <th>Applied</th>
                <th>Rating</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {doc.applications.map((a) => (
                <tr key={String(a.id)}>
                  <td><span className="cell-mono">{String(a.applicationNo ?? '')}</span></td>
                  <td><strong>{String(a.vacancyTitle ?? '')}</strong><br /><span className="cell-mono muted">{String(a.vacancyNo ?? '')}</span></td>
                  <td><Badge value={a.status} /></td>
                  <td className="cell-num">{a.expectedSalary !== null && a.expectedSalary !== undefined ? `${fmtMoney(a.expectedSalary)} ${String(a.currency ?? 'UGX')}` : '-'}</td>
                  <td>{a.appliedAt ? fmtDate(String(a.appliedAt)) : '-'}</td>
                  <td className="cell-num">{a.currentRating !== null && a.currentRating !== undefined ? String(a.currentRating) : '-'}</td>
                  <td className="right">
                    {appOpen(a) && (
                      <div className="row-actions">
                        {can(user, 'hr.applications.advance') && <button className="btn btn-sm" disabled={busy} onClick={() => setAdvanceApp(a)}>Move</button>}
                        {can(user, 'hr.interviews.create') && <button className="btn btn-sm" disabled={busy} onClick={() => setInterviewApp(a)}>Interview</button>}
                        {can(user, 'hr.assessments.create') && <button className="btn btn-sm" disabled={busy} onClick={() => setAssessApp(a)}>Assess</button>}
                        {can(user, 'hr.offers.create') && <button className="btn btn-sm" disabled={busy} onClick={() => setOfferApp(a)}>Offer</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {doc.applications.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No applications yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Interviews</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Interview</th>
                <th>Application</th>
                <th>Scheduled</th>
                <th>Mode</th>
                <th>Duration</th>
                <th>Location</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {doc.interviews.map((x) => (
                <tr key={String(x.id)}>
                  <td><span className="cell-mono">{String(x.interviewNo ?? '')}</span></td>
                  <td className="muted">{appNo(x.applicationId)}</td>
                  <td>{x.scheduledAt ? fmtDate(String(x.scheduledAt)) : '-'}</td>
                  <td><Badge value={x.mode} /></td>
                  <td className="cell-num">{x.durationMinutes ? `${String(x.durationMinutes)}m` : '-'}</td>
                  <td className="muted">{String(x.location ?? '-')}</td>
                  <td><Badge value={x.status} /></td>
                </tr>
              ))}
              {doc.interviews.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No interviews scheduled.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Assessments</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Assessment</th>
                <th>Application</th>
                <th>Type</th>
                <th>Score</th>
                <th>Result</th>
                <th>Assessed</th>
              </tr>
            </thead>
            <tbody>
              {doc.assessments.map((x) => (
                <tr key={String(x.id)}>
                  <td><span className="cell-mono">{String(x.assessmentNo ?? '')}</span></td>
                  <td className="muted">{appNo(x.applicationId)}</td>
                  <td><Badge value={x.type} /></td>
                  <td className="cell-num">{x.score !== null && x.score !== undefined ? `${String(x.score)}/${String(x.maxScore ?? '-')}` : '-'}</td>
                  <td><Badge value={x.result} /></td>
                  <td>{x.assessedAt ? fmtDate(String(x.assessedAt)) : '-'}</td>
                </tr>
              ))}
              {doc.assessments.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No assessments recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Offers</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Offer</th>
                <th>Application</th>
                <th>Base salary</th>
                <th>Allowances</th>
                <th>Contract</th>
                <th>Start date</th>
                <th>Status</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {doc.offers.map((o) => (
                <tr key={String(o.id)}>
                  <td><span className="cell-mono">{String(o.offerNo ?? '')}</span></td>
                  <td className="muted">{appNo(o.applicationId)}</td>
                  <td className="cell-num">{o.baseSalary !== null && o.baseSalary !== undefined ? `${fmtMoney(o.baseSalary)} ${String(o.currency ?? 'UGX')}` : '-'}</td>
                  <td className="muted">{allowancesText(o.allowances)}</td>
                  <td><Badge value={o.contractType} /></td>
                  <td>{o.startDate ? fmtDate(String(o.startDate)) : '-'}</td>
                  <td><Badge value={o.status} /></td>
                  <td className="right">
                    <div className="row-actions">
                      {String(o.status) === 'DRAFT' && can(user, 'hr.offers.send') && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => act(`/api/ops/hcm/offers/${String(o.id)}/send`, {}, 'Offer sent')}>Send</button>
                      )}
                      {String(o.status) === 'SENT' && can(user, 'hr.offers.accept') && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => acceptOffer(o)}>Accept</button>
                      )}
                      {String(o.status) === 'SENT' && can(user, 'hr.offers.decline') && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => declineOffer(o)}>Decline</button>
                      )}
                      {['DRAFT', 'SENT'].includes(String(o.status)) && can(user, 'hr.offers.withdraw') && (
                        <button className="btn btn-sm" disabled={busy}
                          onClick={() => { if (window.confirm(`Withdraw offer ${String(o.offerNo ?? '')}?`)) act(`/api/ops/hcm/offers/${String(o.id)}/withdraw`, {}, 'Offer withdrawn'); }}>
                          Withdraw
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {doc.offers.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No offers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Documents</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Document</th>
                <th>Category</th>
                <th>Resume</th>
                <th>Uploaded</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {doc.documents.map((d) => (
                <tr key={String(d.id)}>
                  <td><strong>{String(d.title ?? d.fileName ?? '')}</strong><br /><span className="cell-mono muted">{String(d.docNo ?? '')}</span></td>
                  <td><Badge value={d.category} /></td>
                  <td>{d.isResume ? 'Yes' : 'No'}</td>
                  <td className="muted">{d.createdAt ? fmtDate(String(d.createdAt)) : '-'}</td>
                  <td className="right">
                    {can(user, 'hr.candidates.view') && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => downloadDocument(d)}>Download</button>
                    )}
                  </td>
                </tr>
              ))}
              {doc.documents.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No documents yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {advanceApp && <AdvanceModal app={advanceApp} onClose={() => setAdvanceApp(null)} onDone={(ok) => { setAdvanceApp(null); setNotice(ok); load(); }} />}
      {interviewApp && <InterviewModal app={interviewApp} onClose={() => setInterviewApp(null)} onDone={(ok) => { setInterviewApp(null); setNotice(ok); load(); }} />}
      {assessApp && <AssessmentModal app={assessApp} onClose={() => setAssessApp(null)} onDone={(ok) => { setAssessApp(null); setNotice(ok); load(); }} />}
      {offerApp && <OfferModal app={offerApp} positions={positions} onClose={() => setOfferApp(null)} onDone={(ok) => { setOfferApp(null); setNotice(ok); load(); }} />}
      {showUpload && <UploadModal id={id} onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); setNotice('Document uploaded'); load(); }} />}
    </div>
  );
}
function parseLines(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(.+?):\s*([\d.,]+)$/);
    if (m) out[m[1].trim()] = Number(m[2].replace(/,/g, ''));
    else out[t] = 0;
  }
  return out;
}

function AdvanceModal({ app, onClose, onDone }: { app: Rec; onClose: () => void; onDone: (ok: string) => void }) {
  const [target, setTarget] = useState('');
  const [rating, setRating] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!target) { setError('Select a target stage'); return; }
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>(`/api/ops/hcm/applications/${String(app.id)}/advance`, {
        method: 'POST',
        body: JSON.stringify({
          targetStage: target,
          rating: rating ? Number(rating) : undefined,
          note: note.trim() || undefined,
        }),
      });
      onDone(`Moved to ${target.replace(/_/g, ' ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Move application ${String(app.applicationNo ?? '')}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Move</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Target stage *</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select stage</option>
            {[...nextStages(String(app.status ?? '')), 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Rating (optional)</label><input inputMode="decimal" value={rating} onChange={(e) => setRating(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function InterviewModal({ app, onClose, onDone }: { app: Rec; onClose: () => void; onDone: (ok: string) => void }) {
  const [scheduledAt, setScheduledAt] = useState('');
  const [mode, setMode] = useState('IN_PERSON');
  const [durationMinutes, setDurationMinutes] = useState('60');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!scheduledAt) { setError('Pick a date and time'); return; }
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/interviews', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: Number(app.id),
          scheduledAt: new Date(scheduledAt).toISOString(),
          mode,
          durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
          location: location.trim() || undefined,
        }),
      });
      onDone('Interview scheduled');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Schedule interview - ${String(app.applicationNo ?? '')}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Schedule</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Date and time *</label><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /></div>
        <div className="field">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['IN_PERSON', 'PHONE', 'VIDEO'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Duration (minutes)</label><input inputMode="numeric" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Location / meeting link</label><input value={location} onChange={(e) => setLocation(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function AssessmentModal({ app, onClose, onDone }: { app: Rec; onClose: () => void; onDone: (ok: string) => void }) {
  const [type, setType] = useState('TECHNICAL');
  const [score, setScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [result, setResult] = useState('PENDING');
  const [assessedAt, setAssessedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/assessments', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: Number(app.id),
          type,
          score: score ? Number(score) : undefined,
          maxScore: maxScore ? Number(maxScore) : undefined,
          result,
          assessedAt: assessedAt || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      onDone('Assessment recorded');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Record assessment - ${String(app.applicationNo ?? '')}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Save assessment</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {['TECHNICAL', 'PSYCHOMETRIC', 'SKILLS', 'LANGUAGE', 'BACKGROUND', 'MEDICAL'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Result</label>
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            {['PENDING', 'PASS', 'FAIL'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field"><label>Score</label><input inputMode="decimal" value={score} onChange={(e) => setScore(e.target.value)} /></div>
        <div className="field"><label>Max score</label><input inputMode="decimal" value={maxScore} onChange={(e) => setMaxScore(e.target.value)} /></div>
        <div className="field"><label>Assessed on</label><input type="date" value={assessedAt} onChange={(e) => setAssessedAt(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
    </Modal>
  );
}
function OfferModal({ app, positions, onClose, onDone }: { app: Rec; positions: Rec[]; onClose: () => void; onDone: (ok: string) => void }) {
  const [positionId, setPositionId] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [allowances, setAllowances] = useState('');
  const [benefits, setBenefits] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [contractType, setContractType] = useState('FULL_TIME');
  const [startDate, setStartDate] = useState('');
  const [probationMonths, setProbationMonths] = useState('6');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!positionId) { setError('Select a position'); return; }
    if (!baseSalary) { setError('Base salary is required'); return; }
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/offers', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: Number(app.id),
          positionId: Number(positionId),
          baseSalary: Number(baseSalary),
          allowances: parseLines(allowances),
          benefits: benefits.trim() || undefined,
          currency: currency.trim() || undefined,
          contractType,
          startDate: startDate || undefined,
          probationMonths: probationMonths ? Number(probationMonths) : undefined,
          expiresAt: expiresAt || undefined,
        }),
      });
      onDone('Offer drafted');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Draft offer - ${String(app.applicationNo ?? '')}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Create offer</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Position *</label>
          <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            <option value="">Select position</option>
            {positions.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.title ?? '')}{p.departmentName ? ` - ${String(p.departmentName)}` : ''}</option>)}
          </select>
        </div>
        <div className="field"><label>Base salary (monthly) *</label><input inputMode="decimal" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} /></div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
        <div className="field">
          <label>Contract type</label>
          <select value={contractType} onChange={(e) => setContractType(e.target.value)}>
            {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'CASUAL'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Start date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
        <div className="field"><label>Probation (months)</label><input inputMode="numeric" value={probationMonths} onChange={(e) => setProbationMonths(e.target.value)} /></div>
        <div className="field"><label>Offer expires</label><input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Allowances (one per line: Name: amount)</label>
          <textarea rows={3} value={allowances} onChange={(e) => setAllowances(e.target.value)} placeholder={'Housing: 500000\nTransport: 200000'} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Benefits (free text)</label><textarea rows={3} value={benefits} onChange={(e) => setBenefits(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function UploadModal({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('CV');
  const [isResume, setIsResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!file) { setError('Choose a PDF file'); return; }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title.trim() || file.name.replace(/\.[^.]+$/, ''));
      fd.append('category', category);
      fd.append('isResume', String(isResume));
      const token = getToken();
      const res = await fetch(`/api/ops/hcm/candidates/${id}/documents/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try {
          const b = await res.json();
          if (b?.error?.message) msg = String(b.error.message);
        } catch { /* non-JSON error body */ }
        throw new Error(msg);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Upload candidate document" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>Upload</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>PDF file *</label>
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to file name" /></div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {['CV', 'CONTRACT', 'ID', 'CERTIFICATE', 'ACADEMIC', 'MEDICAL', 'LICENCE', 'PERFORMANCE', 'DISCIPLINARY', 'TRAINING', 'OTHER'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <label className="check-row"><input type="checkbox" checked={isResume} onChange={(e) => setIsResume(e.target.checked)} /> This is the resume / CV</label>
      </div>
    </Modal>
  );
}
