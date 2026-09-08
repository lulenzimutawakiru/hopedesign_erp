import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Modal, Pager, PageLoader, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS, pickN,
  ATT_STATUS_TONE, APPROVAL_STATUS_TONE, PERIOD_STATUS_TONE,
  EXCEPTION_STATUS_TONE, SEVERITY_TONE, EXCEPTION_TYPE_LABEL,
  statusPill, purposePill, verifPill, fmtWhen, fmtClock, fmtDay, durLabel, empName, empNo, MiniAvatar,
} from './shared';
import { Field, Inp, Sel, Txa, FormErr, Saved } from './fields';
import { qs, isoToday } from './hkutil';

const ATT_OPTIONS = Object.keys(ATT_STATUS_TONE).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));
const APPROVAL_OPTIONS = Object.keys(APPROVAL_STATUS_TONE).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));

const ADJ_TONE: Record<string, string> = {
  PENDING: 'badge-progress',
  APPROVED: 'badge-green',
  REJECTED: 'badge-red',
};
const ADJ_OPTIONS = ['PENDING', 'APPROVED', 'REJECTED'].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));

function monthStart(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}

function AdjStatusPill({ value }: { value: unknown }) {
  const raw = toStr(value);
  if (!raw) return <span className="muted">-</span>;
  return <span className={'badge ' + (ADJ_TONE[raw] ?? 'badge-neutral')}>{raw[0] + raw.slice(1).toLowerCase()}</span>;
}

function ClockCell({ v }: { v: unknown }) {
  const raw = toStr(v);
  if (!raw) return <span className="muted">-</span>;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return <span>{raw}</span>;
  return <span>{d.toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' })}</span>;
}export default function AttendanceHome() {
  const { user } = useAuth();
  const canReview = can(user, 'hr.attendance.review');
  const canApprove = can(user, 'hr.attendance.approve');
  const canReject = can(user, 'hr.attendance.reject');
  const canLock = can(user, 'hr.attendance.lock');
  const canAdjust = can(user, 'hr.attendance.create_adjustment');

  const [tab, setTab] = useState<'records' | 'periods' | 'adjustments'>('records');
  const [data, setData] = useState<Rec | null>(null);
  const [periods, setPeriods] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState('');

  const [status, setStatus] = useState('');
  const [approval, setApproval] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(isoToday());
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [tick, setTick] = useState(0);

  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [adjRows, setAdjRows] = useState<Rec[]>([]);
  const [adjTotal, setAdjTotal] = useState(0);
  const [adjPage, setAdjPage] = useState(1);

  const [adjOpen, setAdjOpen] = useState(false);
  const [newAdj, setNewAdj] = useState(false);
  const [adjEmployeeId, setAdjEmployeeId] = useState('');
  const [adjWorkDate, setAdjWorkDate] = useState('');
  const [adjCheckIn, setAdjCheckIn] = useState('');
  const [adjCheckOut, setAdjCheckOut] = useState('');
  const [adjBreakStart, setAdjBreakStart] = useState('');
  const [adjBreakEnd, setAdjBreakEnd] = useState('');
  const [adjStatus, setAdjStatus] = useState('');
  const [adjNotes, setAdjNotes] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [empQ, setEmpQ] = useState('');
  const [empRows, setEmpRows] = useState<Rec[]>([]);
  const [empBusy, setEmpBusy] = useState(false);

  const [perOpen, setPerOpen] = useState(false);
  const [perCode, setPerCode] = useState('');
  const [perName, setPerName] = useState('');
  const [perStart, setPerStart] = useState(monthStart());
  const [perEnd, setPerEnd] = useState(isoToday());
  const [perNotes, setPerNotes] = useState('');

  const [trans, setTrans] = useState<{ id: string; action: string; label: string } | null>(null);
  const [transReason, setTransReason] = useState('');
  const load = useCallback(async () => {
    try {
      const query = qs({
        attendanceStatus: status || undefined,
        approvalStatus: approval || undefined,
        periodId: periodId || undefined,
        dateFrom: from || undefined,
        dateTo: to || undefined,
        q: q.trim() || undefined,
        page,
        pageSize,
      });
      const r = await api<{ data: Rec }>('/api/attendance' + query);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Attendance failed to load');
    }
  }, [status, approval, periodId, from, to, q, page, pageSize]);
  useEffect(() => { void load(); }, [load, tick]);

  const loadPeriods = useCallback(async () => {
    try {
      const r = await api<{ data: { items: Rec[] } }>('/api/attendance/periods?status=&pageSize=200');
      setPeriods(r.data.items ?? []);
    } catch {
      setPeriods([]);
    }
  }, []);

  const loadAdjustments = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/attendance/adjustments?page=' + adjPage + '&pageSize=25');
      setAdjRows((r.data.items ?? []) as Rec[]);
      setAdjTotal(toNum(r.data.total));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adjustments failed to load');
    }
  }, [adjPage]);

  useEffect(() => { void loadPeriods(); }, [loadPeriods]);
  useEffect(() => { if (tab === 'adjustments') void loadAdjustments(); }, [tab, loadAdjustments]);

  const refresh = () => { setTick((t) => t + 1); };

  const doTransition = async () => {
    if (!trans) return;
    setBusy(true); setFormErr(''); setNote('');
    try {
      const r = await api<{ data: Rec }>('/api/attendance/periods/' + trans.id + '/' + trans.action, {
        method: 'POST',
        body: JSON.stringify({ reason: transReason || undefined }),
      });
      setNote('Period moved to ' + toStr(r.data.status) + '.');
      setTrans(null); setTransReason('');
      setPeriods([]);
      await loadPeriods();
      refresh();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Transition failed');
    } finally {
      setBusy(false);
    }
  };

  const createPeriod = async () => {
    setBusy(true); setFormErr(''); setNote('');
    try {
      await api('/api/attendance/periods', {
        method: 'POST',
        body: JSON.stringify({
          periodCode: perCode.trim(),
          periodName: perName.trim() || undefined,
          startDate: perStart,
          endDate: perEnd,
          notes: perNotes.trim() || undefined,
        }),
      });
      setNote('Attendance period created.');
      setPerOpen(false);
      setPerCode(''); setPerName(''); setPerNotes('');
      await loadPeriods();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Period creation failed');
    } finally {
      setBusy(false);
    }
  };
  const openDetail = async (id: string) => {
    setBusyId(id);
    try {
      const r = await api<{ data: Rec }>('/api/attendance/' + id);
      setDetail(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Record detail failed');
    } finally {
      setBusyId(null);
    }
  };

  const searchEmployees = async (textQ: string) => {
    setEmpQ(textQ);
    if (!textQ.trim()) { setEmpRows([]); return; }
    setEmpBusy(true);
    try {
      const r = await api<{ data: { rows: Rec[] } }>(
        '/api/ops/hr/employees?q=' + encodeURIComponent(textQ.trim()) + '&page=1&pageSize=10'
      );
      setEmpRows(r.data.rows ?? []);
    } catch {
      setEmpRows([]);
    } finally {
      setEmpBusy(false);
    }
  };

  const requestAdjustment = async () => {
    setBusy(true); setFormErr(''); setNote('');
    try {
      await api('/api/attendance/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: adjEmployeeId ? Number(adjEmployeeId) : undefined,
          attendanceRecordId: detail && detail.record ? (detail.record as Rec).id : undefined,
          workDate: adjWorkDate || undefined,
          check_in: adjCheckIn ? new Date(adjCheckIn).toISOString() : undefined,
          check_out: adjCheckOut ? new Date(adjCheckOut).toISOString() : undefined,
          break_start: adjBreakStart ? new Date(adjBreakStart).toISOString() : undefined,
          break_end: adjBreakEnd ? new Date(adjBreakEnd).toISOString() : undefined,
          attendance_status: adjStatus || undefined,
          notes: adjNotes.trim() || undefined,
          reason: adjReason.trim(),
        }),
      });
      setNote('Adjustment requested. An authorised officer must approve it before it affects payroll.');
      setAdjOpen(false); setNewAdj(false);
      setAdjReason(''); setAdjNotes(''); setAdjCheckIn(''); setAdjCheckOut('');
      setAdjBreakStart(''); setAdjBreakEnd(''); setAdjStatus(''); setAdjWorkDate('');
      await loadAdjustments();
      refresh();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Adjustment request failed');
    } finally {
      setBusy(false);
    }
  };

  const adjAction = async (id: string, action: string) => {
    setBusyId(id); setFormErr('');
    try {
      const body = action === 'reject' ? { reason: 'Rejected by reviewer.' } : undefined;
      await api('/api/attendance/adjustments/' + id + '/' + action, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      setNote('Adjustment ' + action + 'd.');
      await loadAdjustments();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adjustment action failed');
    } finally {
      setBusyId(null);
    }
  };


  const [adjFilter, setAdjFilter] = useState('');
  const adjVisible = adjFilter ? adjRows.filter((r) => toStr(r.status) === adjFilter) : adjRows;

  const records = (data && data.items ? data.items : []) as Rec[];
  const total = toNum(data && data.total);
  const presentCount = records.filter((r) => toStr(r.attendanceStatus) === 'PRESENT').length;
  const lateCount = records.filter((r) => toStr(r.attendanceStatus) === 'LATE' || toNum(r.lateMinutes) > 0).length;
  const absentCount = records.filter((r) => toStr(r.attendanceStatus) === 'ABSENT').length;
  const unapprovedCount = records.filter((r) => !['APPROVED', 'LOCKED'].includes(toStr(r.approvalStatus))).length;

  const periodOptions = periods.map((p) => ({
    value: toStr(pickN(p, 'id')),
    label: toStr(pickS(p, 'periodCode')) + ' - ' + (pickS(p, 'periodName') || pickS(p, 'periodCode')),
  }));

  const openNewAdjust = () => {
    setDetail(null);
    setNewAdj(false);
    setAdjOpen(true);
    setFormErr('');
    setAdjEmployeeId('');
    setAdjWorkDate('');
    setAdjCheckIn(''); setAdjCheckOut(''); setAdjBreakStart(''); setAdjBreakEnd('');
    setAdjStatus(''); setAdjNotes(''); setAdjReason('');
    setEmpQ(''); setEmpRows([]);
  };

  const openAdjustForRecord = (rec: Rec) => {
    const emp = (rec.employee ?? null) as Rec | null;
    setNewAdj(true);
    setAdjOpen(true);
    setFormErr('');
    setAdjEmployeeId(emp ? toStr(pickN(emp, 'id')) : '');
    setAdjWorkDate(toStr(rec.workDate));
    setAdjCheckIn(''); setAdjCheckOut(''); setAdjBreakStart(''); setAdjBreakEnd('');
    setAdjStatus(''); setAdjNotes(''); setAdjReason('');
    setEmpQ(''); setEmpRows([]);
  };

  const periodActions = (p: Rec): { action: string; label: string; allowed: boolean }[] => {
    const s = toStr(p.status);
    if (s === 'OPEN') return [{ action: 'submit', label: 'Submit for approval', allowed: canReview }];
    if (s === 'PENDING_APPROVAL') return [{ action: 'approve', label: 'Approve for payroll', allowed: canApprove }];
    if (s === 'APPROVED') return [{ action: 'lock', label: 'Lock period', allowed: canLock }];
    if (s === 'LOCKED') return [{ action: 'reopen', label: 'Reopen period', allowed: canLock }];
    return [];
  };

  if (!data && tab === 'records') return (
    <div className="page">
      <HikHead title="Attendance" subtitle="Approved, payroll-ready attendance derived from Hikvision punches." />
      <HikTabs active="attendance" />
      {error ? <ErrorBanner error={error} /> : null}
      <PageLoader label="Loading attendance..." />
    </div>
  );

  return (
    <div className="page">
      <HikHead
        title="Attendance"
        subtitle="Biometric punches, shift evaluation and approval workflow feeding payroll periods."
        actions={
          <div className="hk-inline">
            <Saved msg={note} />
            <button type="button" className="btn btn-sm" onClick={refresh}>Refresh</button>
          </div>
        }
      />
      <HikTabs active="attendance" />
      {error ? <ErrorBanner error={error} /> : null}
      {formErr ? <FormErr msg={formErr} /> : null}

      <div className="hk-tabs" role="tablist" aria-label="Attendance sections" style={{ marginTop: 14 }}>
        <button type="button" className={'tab' + (tab === 'records' ? ' active' : '')} onClick={() => setTab('records')}>Daily records</button>
        <button type="button" className={'tab' + (tab === 'periods' ? ' active' : '')} onClick={() => setTab('periods')}>Payroll periods</button>
        <button type="button" className={'tab' + (tab === 'adjustments' ? ' active' : '')} onClick={() => setTab('adjustments')}>Adjustments</button>
      </div>

      {tab === 'records' ? (
        <section className="card card-pad" style={{ marginTop: 14 }}>
          <div className="kpi-grid">
            <div className="card card-pad">
              <span className="kpi-label">Present (page)</span>
              <span className="kpi-value">{presentCount}</span>
            </div>
            <div className="card card-pad">
              <span className="kpi-label">Late / early</span>
              <span className="kpi-value">{lateCount}</span>
            </div>
            <div className="card card-pad">
              <span className="kpi-label">Absent</span>
              <span className="kpi-value">{absentCount}</span>
            </div>
            <div className="card card-pad">
              <span className="kpi-label">Unapproved</span>
              <span className="kpi-value">{unapprovedCount}</span>
            </div>
            <div className="card card-pad">
              <span className="kpi-label">Total match</span>
              <span className="kpi-value">{total}</span>
              <span className="kpi-sub">Org-scoped records</span>
            </div>
          </div>

          <div className="hk-board-grid" style={{ marginTop: 14 }}>
            <div className="hk-card-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
              <Field label="Attendance status">
                <Sel value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={ATT_OPTIONS} placeholder="All statuses" />
              </Field>
              <Field label="Approval status">
                <Sel value={approval} onChange={(v) => { setApproval(v); setPage(1); }} options={APPROVAL_OPTIONS} placeholder="All statuses" />
              </Field>
              <Field label="Period">
                <Sel value={periodId} onChange={(v) => { setPeriodId(v); setPage(1); }} options={periodOptions} placeholder="Any period" />
              </Field>
              <Field label="Employee search">
                <Inp value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name / employee number..." />
              </Field>
              <Field label="From">
                <Inp type="date" value={from} onChange={(v) => { setFrom(v); setPage(1); }} />
              </Field>
              <Field label="To">
                <Inp type="date" value={to} onChange={(v) => { setTo(v); setPage(1); }} />
              </Field>
              <Field label="Reset">
                <button type="button" className="btn" onClick={() => { setStatus(''); setApproval(''); setPeriodId(''); setQ(''); setPage(1); }}>Clear filters</button>
              </Field>
            </div>
          </div>

          {records.length === 0 ? (
            <div className="empty-state"><h3>No attendance records</h3><p>Punches are processed into records as terminals report events. Adjust the filters or check the Live board.</p></div>
          ) : (
            <>
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Employee</th><th>Date</th><th>In</th><th>Out</th><th>Worked</th>
                      <th>Late</th><th>Overtime</th><th>Status</th><th>Approval</th><th>Shift</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => {
                      const emp = (r.employee ?? null) as Rec | null;
                      return (
                        <tr key={toStr(r.id)}>
                          <td>
                            <div className="emp-cell">
                              {emp ? <MiniAvatar name={empName(emp)} /> : null}
                              <div>
                                <strong>{emp ? empName(emp) : 'Unknown'}</strong>
                                <span className="muted">{emp ? empNo(emp) : ''}{r.departmentName ? ' \u00B7 ' + toStr(r.departmentName) : ''}</span>
                              </div>
                            </div>
                          </td>
                          <td>{fmtDay(r.workDate)}</td>
                          <td><ClockCell v={r.checkIn} /></td>
                          <td><ClockCell v={r.checkOut} /></td>
                          <td>{durLabel(r.workedMinutes)}</td>
                          <td>{toNum(r.lateMinutes) > 0 ? <span className="badge badge-amber">{toNum(r.lateMinutes)}m</span> : <span className="muted">-</span>}</td>
                          <td>{toNum(r.overtimeMinutes) > 0 ? <span className="badge badge-green">{toNum(r.overtimeMinutes)}m</span> : <span className="muted">-</span>}</td>
                          <td>{statusPill(r.attendanceStatus, ATT_STATUS_TONE)}</td>
                          <td>{statusPill(r.approvalStatus, APPROVAL_STATUS_TONE)}</td>
                          <td><span className="muted">{toStr(r.shiftCode) || '-'}</span></td>
                          <td>
                            <button type="button" className="btn btn-sm" disabled={busyId === toStr(r.id)} onClick={() => void openDetail(toStr(r.id))}>
                              {busyId === toStr(r.id) ? 'Loading...' : 'Detail'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
            </>
          )}
        </section>
      ) : null}

      {tab === 'periods' ? (
        <section className="card card-pad" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Attendance &amp; payroll periods</h3>
            <div className="head-actions">
              <button type="button" className="btn btn-sm" onClick={() => void loadPeriods()}>Refresh</button>
              {canLock ? (
                <button type="button" className="btn" onClick={() => { setPerOpen(true); setFormErr(''); setPerCode(''); setPerName(''); setPerNotes(''); }}>New period</button>
              ) : null}
            </div>
          </div>
          {periods.length === 0 ? (
            <div className="empty-state"><h3>No payroll periods</h3><p>Create an OPEN period to group attendance records for approval and payroll locking.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Period</th><th>Dates</th><th>Branch</th><th>Status</th><th>Records</th><th>Approved</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={toStr(pickN(p, 'id'))}>
                      <td>
                        <strong>{pickS(p, 'periodCode')}</strong>
                        {pickS(p, 'periodName') && pickS(p, 'periodName') !== pickS(p, 'periodCode') ? <div className="muted">{pickS(p, 'periodName')}</div> : null}
                      </td>
                      <td>{fmtDay(p.startDate)} {'\u2192'} {fmtDay(p.endDate)}</td>
                      <td>{toStr(p.branchName) || <span className="muted">Company-wide</span>}</td>
                      <td>{statusPill(p.status, PERIOD_STATUS_TONE, { OPEN: 'Open', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved', LOCKED: 'Locked' })}</td>
                      <td>{toNum(p.recordCount)}</td>
                      <td>
                        {toNum(p.approvedCount) > 0 ? (
                          <span className={'badge ' + (toNum(p.approvedCount) === toNum(p.recordCount) ? 'badge-green' : 'badge-amber')}>
                            {toNum(p.approvedCount)} / {toNum(p.recordCount)}
                          </span>
                        ) : <span className="muted">0</span>}
                      </td>
                      <td>
                        <div className="hk-inline">
                          {periodActions(p).filter((a) => a.allowed).map((a) => (
                            <button key={a.action} type="button" className="btn btn-sm" onClick={() => { setTrans({ id: toStr(pickN(p, 'id')), action: a.action, label: a.label }); setTransReason(''); setFormErr(''); }}>
                              {a.label}
                            </button>
                          ))}
                          {periodActions(p).filter((a) => a.allowed).length === 0 ? <span className="muted">Locked or no permission</span> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'adjustments' ? (
        <section className="card card-pad" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Manual adjustments</h3>
            <div className="head-actions">
              <select className="hk-select" value={adjFilter} onChange={(e) => setAdjFilter(e.target.value)} aria-label="Adjustment status">
                <option value="">All statuses</option>
                {ADJ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button type="button" className="btn btn-sm" onClick={() => void loadAdjustments()}>Refresh</button>
              {canAdjust ? (
                <button type="button" className="btn" onClick={openNewAdjust}>Request adjustment</button>
              ) : null}
            </div>
          </div>
          {adjVisible.length === 0 ? (
            <div className="empty-state"><h3>No adjustments</h3><p>Authorised HR officers can correct a punch before the period is locked.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Employee</th><th>Date</th><th>Type</th><th>Reason</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {adjVisible.map((x) => {
                    const emp = (x.employee ?? null) as Rec | null;
                    return (
                      <tr key={toStr(x.id)}>
                        <td><span className="muted">{fmtWhen(x.createdAt)}</span></td>
                        <td>
                          <div className="emp-cell">
                            {emp ? <MiniAvatar name={empName(emp)} /> : null}
                            <div><strong>{emp ? empName(emp) : 'Unknown'}</strong><span className="muted">{emp ? empNo(emp) : ''}</span></div>
                          </div>
                        </td>
                        <td>{fmtDay(x.workDate)}</td>
                        <td>{toStr(x.adjustmentType).replace(/_/g, ' ') || '-'}</td>
                        <td style={{ maxWidth: 260 }}><span className="muted">{toStr(x.reason)}</span></td>
                        <td><AdjStatusPill value={x.status} /></td>
                        <td>
                          <div className="hk-inline">
                            {toStr(x.status) === 'PENDING' && canApprove ? (
                              <button type="button" className="btn btn-sm" disabled={busyId === toStr(x.id)} onClick={() => void adjAction(toStr(x.id), 'approve')}>Approve</button>
                            ) : null}
                            {toStr(x.status) === 'PENDING' && canReject ? (
                              <button type="button" className="btn btn-sm btn-danger" disabled={busyId === toStr(x.id)} onClick={() => void adjAction(toStr(x.id), 'reject')}>Reject</button>
                            ) : null}
                            {toStr(x.status) !== 'PENDING' ? <span className="muted">Processed</span> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={adjPage} pageSize={25} total={adjTotal} onPage={setAdjPage} />
        </section>
      ) : null}

      {perOpen ? (
        <Modal
          title="New attendance period"
          onClose={() => setPerOpen(false)}
          footer={
            <div className="hk-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setPerOpen(false)}>Cancel</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void createPeriod()}>{busy ? 'Creating...' : 'Create period'}</button>
            </div>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>Periods gate payroll: records are only exported once a period is approved and locked.</p>
          <div className="hk-card-grid">
            <Field label="Period code" req hint="Unique reference, e.g. JUNE-2026.">
              <Inp value={perCode} onChange={setPerCode} placeholder="JUNE-2026" />
            </Field>
            <Field label="Period name" hint="Optional display name.">
              <Inp value={perName} onChange={setPerName} placeholder="June 2026 payroll" />
            </Field>
            <Field label="Start date" req>
              <Inp type="date" value={perStart} onChange={setPerStart} />
            </Field>
            <Field label="End date" req>
              <Inp type="date" value={perEnd} onChange={setPerEnd} />
            </Field>
            <Field label="Notes">
              <Txa value={perNotes} onChange={setPerNotes} placeholder="Optional context for the period" />
            </Field>
          </div>
        </Modal>
      ) : null}

      {trans ? (
        <Modal
          title={trans.label}
          onClose={() => setTrans(null)}
          footer={
            <div className="hk-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setTrans(null)}>Cancel</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void doTransition()}>{busy ? 'Working...' : 'Confirm ' + trans.label.toLowerCase()}</button>
            </div>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>Confirm {trans.label.toLowerCase()} for this period. The action is recorded in the audit trail and cannot be undone without an authorised reopen.</p>
          <Field label="Reason" hint="Optional - recommended for the audit trail.">
            <Txa value={transReason} onChange={setTransReason} placeholder="Reason for this transition" />
          </Field>
        </Modal>
      ) : null}

      {adjOpen ? (
        <Modal
          title={newAdj ? 'Adjust time for employee' : 'Request manual adjustment'}
          onClose={() => setAdjOpen(false)}
          wide
          footer={
            <div className="hk-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setAdjOpen(false)}>Cancel</button>
              <button type="button" className="btn" disabled={busy || !adjEmployeeId} onClick={() => void requestAdjustment()}>
                {busy ? 'Submitting...' : 'Submit adjustment'}
              </button>
            </div>
          }
        >
          {newAdj ? (
            <div className="notice-banner" style={{ marginTop: 0 }}>Correction for the selected attendance record. An authorised officer approves before payroll.</div>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>Search and select the employee whose punch record you need to correct.</p>
          )}
          <div className="hk-card-grid">
            <Field label="Employee" req hint="Type at least three characters to search.">
              <Inp value={empQ} onChange={(v) => void searchEmployees(v)} placeholder="Search employee..." />
            </Field>
            {empBusy ? <div className="muted" style={{ fontSize: 13 }}>Searching...</div> : null}
            {empRows.length > 0 ? (
              <div className="feed" style={{ marginTop: 4 }}>
                {empRows.map((row) => (
                  <li className="feed-item" key={toStr(pickN(row, 'id'))}>
                    <MiniAvatar name={empName(row)} />
                    <div className="feed-body">
                      <div className="feed-title"><strong>{empName(row)}</strong></div>
                      <div className="feed-meta">{empNo(row)} {pickS(row, 'position') ? ' \u00B7 ' + pickS(row, 'position') : ''}</div>
                    </div>
                    <button type="button" className="btn btn-sm" onClick={() => { setAdjEmployeeId(toStr(pickN(row, 'id'))); setEmpRows([]); setEmpQ(empName(row)); }}>Select</button>
                  </li>
                ))}
              </div>
            ) : null}
            <Field label="Work date">
              <Inp type="date" value={adjWorkDate} onChange={setAdjWorkDate} />
            </Field>
            <Field label="Check-in (optional)">
              <Inp type="datetime-local" value={adjCheckIn} onChange={setAdjCheckIn} />
            </Field>
            <Field label="Check-out (optional)">
              <Inp type="datetime-local" value={adjCheckOut} onChange={setAdjCheckOut} />
            </Field>
            <Field label="Break start (optional)">
              <Inp type="datetime-local" value={adjBreakStart} onChange={setAdjBreakStart} />
            </Field>
            <Field label="Break end (optional)">
              <Inp type="datetime-local" value={adjBreakEnd} onChange={setAdjBreakEnd} />
            </Field>
            <Field label="Override status" hint="Optional - overrides the evaluated status.">
              <Sel value={adjStatus} onChange={setAdjStatus} options={ATT_OPTIONS} placeholder="Keep evaluated status" />
            </Field>
            <Field label="Notes">
              <Txa value={adjNotes} onChange={setAdjNotes} placeholder="What changed and why" />
            </Field>
            <Field label="Reason" req>
              <Txa value={adjReason} onChange={setAdjReason} placeholder="Mandatory reason for the audit trail" />
            </Field>
          </div>
        </Modal>
      ) : null}

      {detail ? (() => {
        const rec = (detail.record ?? null) as Rec | null;
        if (!rec) return null;
        const emp = (rec.employee ?? null) as Rec | null;
        const punches = (detail.punches ?? []) as Rec[];
        const excRows = (detail.exceptions ?? []) as Rec[];
        const adjRowsDetail = (detail.adjustments ?? []) as Rec[];
        const audit = (detail.auditHistory ?? []) as Rec[];
        return (
          <Modal
            title={'Attendance record - ' + (emp ? empName(emp) : '')}
            onClose={() => setDetail(null)}
            wide
            footer={
              <div className="hk-actions">
                {canAdjust ? (
                  <button type="button" className="btn" onClick={() => { openAdjustForRecord(rec); }}>Request adjustment</button>
                ) : null}
                <button type="button" className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>
              </div>
            }
          >
            <div className="hk-board-grid">
              <div className="def-sec">
                <span className="kpi-label">Employee</span>
                <div className="emp-cell">
                  {emp ? <MiniAvatar name={empName(emp)} /> : null}
                  <div>
                    <strong>{emp ? empName(emp) : 'Unknown'}</strong>
                    <span className="muted">{emp ? empNo(emp) : ''} {rec.departmentName ? ' \u00B7 ' + toStr(rec.departmentName) : ''}</span>
                  </div>
                </div>
              </div>
              <div className="def-sec">
                <span className="kpi-label">Status</span>
                <div>{statusPill(rec.attendanceStatus, ATT_STATUS_TONE)} {statusPill(rec.approvalStatus, APPROVAL_STATUS_TONE)}</div>
                <span className="muted">{toStr(rec.source)} {rec.rawPunchCount != null ? ' \u00B7 ' + toNum(rec.rawPunchCount) + ' punch(es)' : ''}</span>
              </div>
              <div className="def-sec">
                <span className="kpi-label">Day</span>
                <div><strong>{fmtDay(rec.workDate)}</strong></div>
                <span className="muted">{(rec.period && (rec.period as Rec).code) ? 'Period ' + toStr((rec.period as Rec).code) : ''} {rec.shiftCode ? ' \u00B7 Shift ' + toStr(rec.shiftCode) : ''}</span>
              </div>
              <div className="def-sec">
                <span className="kpi-label">Times</span>
                <div>In <strong>{fmtClock(rec.checkIn)}</strong> {'\u00B7'} Out <strong>{fmtClock(rec.checkOut)}</strong></div>
                <span className="muted">Scheduled {durLabel(rec.scheduledMinutes)} {rec.breakMinutes ? ' \u00B7 Break ' + durLabel(rec.breakMinutes) : ''}</span>
              </div>
            </div>

            <div className="hk-card-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginTop: 12 }}>
              <div className="def-sec"><span className="kpi-label">Worked</span><strong>{durLabel(rec.workedMinutes)}</strong></div>
              <div className="def-sec"><span className="kpi-label">Late</span>{toNum(rec.lateMinutes) > 0 ? <span className="badge badge-amber">{toNum(rec.lateMinutes)}m</span> : <span className="muted">None</span>}</div>
              <div className="def-sec"><span className="kpi-label">Overtime</span>{toNum(rec.overtimeMinutes) > 0 ? <span className="badge badge-green">{toNum(rec.overtimeMinutes)}m</span> : <span className="muted">None</span>}</div>
              <div className="def-sec"><span className="kpi-label">Undertime</span>{toNum(rec.undertimeMinutes) > 0 ? <span className="badge badge-amber">{toNum(rec.undertimeMinutes)}m</span> : <span className="muted">None</span>}</div>
            </div>

            <div className="card-head" style={{ marginTop: 14 }}><h3>Punches</h3></div>
            {punches.length === 0 ? (
              <div className="empty-state"><h3>No punches linked</h3><p>This record may have been created by an adjustment or system rule.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Time</th><th>Type</th><th>Verification</th><th>Purpose</th><th>Terminal</th><th>Location</th></tr></thead>
                  <tbody>
                    {punches.map((pu) => (
                      <tr key={toStr(pu.id)}>
                        <td>{fmtWhen(pu.punch_time)}</td>
                        <td>{toStr(pu.punch_type).replace(/_/g, ' ')}</td>
                        <td>{verifPill(pu.verification_method)}</td>
                        <td>{purposePill(pu.device_purpose)}</td>
                        <td>{toStr(pu.device_name) || <span className="muted">{toStr(pu.device_code) || '-'}</span>}</td>
                        <td><span className="muted">{toStr(pu.location) || '-'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="card-head" style={{ marginTop: 14 }}><h3>Exceptions</h3></div>
            {excRows.length === 0 ? (
              <p className="muted">No open exceptions for this record.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Type</th><th>Severity</th><th>Status</th><th>Summary</th></tr></thead>
                  <tbody>
                    {excRows.map((x) => (
                      <tr key={toStr(x.id)}>
                        <td>{EXCEPTION_TYPE_LABEL[toStr(x.exception_type).toUpperCase()] ?? toStr(x.exception_type)}</td>
                        <td>{statusPill(x.severity, SEVERITY_TONE, { INFO: 'Info', WARN: 'Warning', ERROR: 'Error', CRITICAL: 'Critical' })}</td>
                        <td>{statusPill(x.status, EXCEPTION_STATUS_TONE)}</td>
                        <td style={{ maxWidth: 320 }}><span className="muted">{toStr(x.summary)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="card-head" style={{ marginTop: 14 }}><h3>Adjustments</h3></div>
            {adjRowsDetail.length === 0 ? (
              <p className="muted">No adjustments.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Created</th><th>Type</th><th>Status</th><th>Reason</th></tr></thead>
                  <tbody>
                    {adjRowsDetail.map((x) => (
                      <tr key={toStr(x.id)}>
                        <td><span className="muted">{fmtWhen(x.created_at)}</span></td>
                        <td>{toStr(x.adjustment_type).replace(/_/g, ' ')}</td>
                        <td><AdjStatusPill value={x.status} /></td>
                        <td style={{ maxWidth: 300 }}><span className="muted">{toStr(x.reason)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="card-head" style={{ marginTop: 14 }}><h3>Audit trail</h3></div>
            {audit.length === 0 ? (
              <p className="muted">No audit entries for this record.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Action</th><th>User</th><th>Detail</th></tr></thead>
                  <tbody>
                    {audit.map((x, i) => (
                      <tr key={i}>
                        <td><span className="muted">{fmtWhen(x.created_at)}</span></td>
                        <td><code style={{ fontSize: 12 }}>{toStr(x.action)}</code></td>
                        <td><span className="muted">#{toStr(x.user_id) || '-'}</span></td>
                        <td style={{ maxWidth: 320 }}><span className="muted">{toStr(x.metadata ? JSON.stringify(x.metadata) : x.old_values ? JSON.stringify(x.old_values) : '')}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Modal>
        );
      })() : null}
    </div>
  );
}