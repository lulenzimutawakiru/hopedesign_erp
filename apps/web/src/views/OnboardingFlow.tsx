import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

const ONB_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];

export default function OnboardingFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const view = parts[1] ?? 'onboarding';
  const id = parts[2] ?? null;
  if (view === 'onboarding' && id) return <OnboardingDesk id={Number(id)} />;
  if (view === 'onboardings' && id) return <OnboardingDesk id={Number(id)} />;
  return <OnboardingList />;
}

function OnboardingList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hcm/onboardings?pageSize=100')
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Onboarding cases failed'));
  }, []);
  const visible = filter ? rows.filter((r) => String(r.status) === filter) : rows;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HCM</p>
          <h1>Onboarding</h1>
          <p className="muted">New-hire cases created automatically when an offer is accepted. Track checklists, task progress and orientation across the company.</p>
        </div>
        <div className="head-actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {ONB_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase().replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Case</th><th>Employee</th><th>Position</th><th>Checklist</th><th>Status</th><th>Started</th><th>Completed</th><th className="cell-num">Pending tasks</th></tr></thead>
          <tbody>
            {visible.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/onboarding/${String(r.id)}`)}>
                <td className="cell-mono">{String(r.instanceNo)}</td>
                <td>{String(r.firstName)} {String(r.lastName)} <span className="cell-mono">{String(r.employeeNo ?? '')}</span></td>
                <td>{String(r.positionName ?? '-')}</td>
                <td>{String(r.checklistName ?? '-')}</td>
                <td><Badge value={r.status} /></td>
                <td>{r.startedAt ? fmtDate(r.startedAt) : '-'}</td>
                <td>{r.completedAt ? fmtDate(r.completedAt) : '-'}</td>
                <td className="cell-num">{fmtNum(r.pendingTasks)}</td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No onboarding cases yet. Onboarding cases are created automatically when a job offer is accepted.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function OnboardingDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ instance: Rec; tasks: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState<number | null>(null);
  const [taskNotes, setTaskNotes] = useState<Rec>({});
  const load = useCallback(() => {
    api<{ data: { instance: Rec; tasks: Rec[] } }>(`/api/ops/hcm/onboardings/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Onboarding case failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening onboarding case" />;
  const s = doc.instance;
  const tasks = doc.tasks ?? [];
  const status = String(s.status);
  const completed = tasks.filter((t) => ['COMPLETED', 'SKIPPED'].includes(String(t.status))).length;
  const pendingTasks = tasks.length - completed;
  const canStart = status === 'PENDING' && can(user, 'hr.onboarding.start');
  const canCompleteTask = status === 'IN_PROGRESS' && can(user, 'hr.onboarding.update');
  const canComplete = status === 'IN_PROGRESS' && pendingTasks === 0 && can(user, 'hr.onboarding.complete');
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
  const completeTask = async (t: Rec) => {
    const taskId = Number(t.taskId);
    setTaskBusy(taskId); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/hcm/onboarding/${id}/tasks/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ notes: String(taskNotes[String(taskId)] ?? '').trim() || undefined }),
      });
      setNotice(`${String(t.title)} completed - ${fmtNum(r.data.remaining)} task(s) pending.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setTaskBusy(null); }
  };  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/onboarding')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Onboarding</p>
          <h1>Case <span className="cell-mono">{String(s.instanceNo)}</span></h1>
          <p className="muted">{String(s.firstName)} {String(s.lastName)} <span className="cell-mono">{String(s.employeeNo)}</span> - {String(s.positionName ?? 'New hire')}</p>
        </div>
        <Badge value={s.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Checklist</span><span className="kpi-value">{String(s.checklistName ?? '-')}</span></div>
        <div className="kpi-card"><span className="kpi-label">Employee status</span><span className="kpi-value">{String(s.employeeStatus ?? '-')}</span></div>
        <div className="kpi-card"><span className="kpi-label">Started</span><span className="kpi-value">{s.startedAt ? fmtDate(s.startedAt) : '-'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Completed</span><span className="kpi-value">{s.completedAt ? fmtDate(s.completedAt) : '-'}</span></div>
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {canStart && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hcm/onboarding/${id}/start`, 'Onboarding started - checklist tasks are now open.')}>Start onboarding</button>
        )}
        {Number(s.employeeId) > 0 && (
          <button className="btn" onClick={() => navigate(`/people/employees/${String(s.employeeId)}`)}>Open employee record</button>
        )}
      </div>
      <section className="card card-pad">
        <div className="card-head"><h3>Onboarding details</h3></div>
        <p><strong>Employee:</strong> {String(s.firstName)} {String(s.lastName)} <span className="cell-mono">{String(s.employeeNo)}</span></p>
        <p><strong>Position:</strong> {String(s.positionName ?? '-')}</p>
        <p><strong>Checklist:</strong> {String(s.checklistName ?? '-')}</p>
        {s.offerId != null && <p><strong>Offer reference:</strong> <span className="cell-mono">#{String(s.offerId)}</span></p>}
      </section>
      <section className="card">
        <div className="card-head"><h3>Checklist tasks</h3><span className="muted">{fmtNum(completed)} / {fmtNum(tasks.length)} completed</span></div>
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
                  <td>{t.completedAt ? `${String(t.completedAt).slice(0, 10)}${t.completedBy ? ` by ${String(t.completedBy)}` : ''}` : '-'}</td>
                  <td>
                    {canCompleteTask && !['COMPLETED', 'SKIPPED'].includes(String(t.status)) ? (
                      <input type="text" style={{ minWidth: 150 }} placeholder="Notes (optional)" value={String(taskNotes[String(t.taskId)] ?? '')} onChange={(e) => setTaskNotes((prev) => ({ ...prev, [String(t.taskId)]: e.target.value }))} />
                    ) : (
                      <span className="muted">{String(t.notes ?? '-')}</span>
                    )}
                  </td>
                  <td>
                    {canCompleteTask && !['COMPLETED', 'SKIPPED'].includes(String(t.status)) ? (
                      <span className="row-actions">
                        <button className="btn btn-sm btn-success" disabled={taskBusy === Number(t.taskId)} onClick={() => completeTask(t)}>Complete</button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
              {tasks.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tasks on this onboarding checklist.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {canComplete && (
        <section className="card card-pad">
          <div className="card-head"><h3>Complete onboarding</h3></div>
          <p className="muted" style={{ marginBottom: 12 }}>All checklist tasks are complete. Close this case to mark the employee as onboarded. Their employment record and payroll profile are not affected by this step.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hcm/onboarding/${id}/complete`, 'Onboarding completed - employee is fully onboarded.')}>Complete onboarding</button>
        </section>
      )}
    </div>
  );
}