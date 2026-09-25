import { useCallback, useEffect, useState } from 'react';
import { api, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { type Rec } from './hrShared';

/**
 * Offboarding and exits: the case register, the composer that opens a case and the
 * desk that runs clearance. Lifted out of HrFlow so the flow file stops owning the
 * exit process end to end.
 */

export const OFFBOARDING_TYPES = ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'TRANSFER', 'OTHER'];

export function OffboardingList() {
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

export function OffboardingComposer() {
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

export function OffboardingDesk({ id }: { id: number }) {
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
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; keepReason?: boolean; run: (reason: string) => void } | null>(null);
  const load = useCallback(() => {
    api<{ data: { instance: Rec; tasks: Rec[] } }>(`/api/ops/hcm/offboardings/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Offboarding case failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening offboarding case" />;
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
          <button className="btn" disabled={busy} onClick={() => setConfirm({
            title: 'Cancel offboarding case',
            body: `Cancel ${String(s.instanceNo)}? The clearance checklist is closed and the case is withdrawn. The employee record is not changed by this action.`,
            label: 'Cancel case',
            danger: true,
            keepReason: true,
            run: (reason) => act(`/api/ops/hcm/offboardings/${id}/cancel`, 'Offboarding case cancelled.', { reason: reason.trim() || undefined }),
          })}>Cancel case</button>
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
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || pendingTasks > 0} onClick={() => setConfirm({
            title: 'Complete offboarding',
            body: `Close ${String(s.instanceNo)} and mark ${String(s.firstName)} ${String(s.lastName)} as exited on ${alumniDate || String(s.effectiveDate ?? '').slice(0, 10) || 'the effective date'}? This updates the employee status and cannot be reversed from here.`,
            label: 'Complete offboarding',
            danger: true,
            run: () => act(`/api/ops/hcm/offboardings/${id}/complete`, 'Offboarding completed - employee marked as exited.', {
              exitInterviewNotes: exitNotes.trim() || undefined,
              alumniDate: alumniDate || undefined,
              rehireEligible,
            }),
          })}>Complete offboarding</button>
        </section>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          reasonLabel={confirm.keepReason ? undefined : null}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { const c = confirm; setConfirm(null); if (c) c.run(reason); }}
        />
      )}
    </div>
  );
}