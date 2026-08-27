import { useCallback, useEffect, useState } from 'react';
import { api, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

const REQUEST_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'];
const LEAVE_TYPE_DEFAULTS = ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'UNPAID', 'STUDY', 'COMPASSIONATE', 'OTHER'];

export default function LeaveFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const view = parts[2] ?? 'requests';
  if (view === 'balances') return <LeaveBalances />;
  if (view === 'calendar') return <LeaveCalendar />;
  return <LeaveRequests />;
}

// ============================================================
// LEAVE REQUESTS
// ============================================================

function LeaveRequests() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [composer, setComposer] = useState(false);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    api<{ data: Rec[] }>(`/api/ops/hr/leave?${params.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Leave failed'));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  const decide = async (id: number, action: 'approve' | 'reject') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/hr/leave/${id}/${action}`, { method: 'POST', body: '{}' });
      setNotice(action === 'approve' ? 'Leave request approved - balance updated' : 'Leave request rejected');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Leave management</p>
          <h1>Leave requests</h1>
          <p className="muted">Submit, review and approve leave. Entitlements, accruals and approval rules come from the configured leave policies.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people/leave/calendar')}>Calendar</button>
          <button className="btn" onClick={() => navigate('/people/leave/balances')}>Balances</button>
          {can(user, 'hr.leave.create') && <button className="btn btn-primary" onClick={() => setComposer(true)}>New request</button>}
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th className="cell-num">Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const canDecide = String(r.status) === 'SUBMITTED' && can(user, 'hr.leave.approve');
              return (
                <tr key={String(r.id)}>
                  <td><div className="cell-mono">{String(r.employeeNo ?? '')}</div><strong>{String(r.firstName ?? '')} {String(r.lastName ?? '')}</strong></td>
                  <td>{String(r.leaveType ?? '-')}</td>
                  <td>{String(r.startDate ?? '').slice(0, 10)}</td>
                  <td>{String(r.endDate ?? '').slice(0, 10)}</td>
                  <td className="cell-num">{fmtNum(r.days)}</td>
                  <td className="muted">{String(r.reason ?? '-')}</td>
                  <td><Badge value={r.status} /></td>
                  <td>
                    {canDecide && (
                      <div className="row-actions">
                        <button className="btn btn-sm btn-success" disabled={busy} onClick={() => decide(Number(r.id), 'approve')}>Approve</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => decide(Number(r.id), 'reject')}>Reject</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No leave requests match the current filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {composer && <RequestComposer onClose={() => setComposer(false)} onSaved={() => { setComposer(false); setNotice('Leave request submitted'); load(); }} />}
    </div>
  );
}

function RequestComposer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [types, setTypes] = useState<string[]>(LEAVE_TYPE_DEFAULTS);
  const [employeeId, setEmployeeId] = useState('');
  const [leaveType, setLeaveType] = useState('ANNUAL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=100')
      .then((r) => setEmployees(r.data.rows ?? []))
      .catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/leave/balances')
      .then((r) => {
        const codes = Array.from(new Set((r.data ?? []).map((b) => String(b.leaveTypeCode ?? '')).filter(Boolean)));
        if (codes.length) setTypes(Array.from(new Set([...LEAVE_TYPE_DEFAULTS, ...codes])));
      })
      .catch(() => undefined);
  }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/hr/leave', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(employeeId),
          leaveType,
          startDate,
          endDate,
          reason: reason.trim() || null,
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New leave request" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !employeeId || !startDate || !endDate} onClick={save}>{busy ? 'Saving...' : 'Submit request'}</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field field-required"><label>Employee</label>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Select employee...</option>
            {employees.map((em) => <option key={String(em.id)} value={String(em.id)}>{String(em.employeeNo ?? '')} - {String(em.firstName ?? '')} {String(em.lastName ?? '')}</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Leave type</label>
          <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
            {types.map((t) => <option key={t} value={t}>{t.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Start date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
        <div className="field field-required"><label>End date</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Reason</label><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}

// ============================================================
// LEAVE BALANCES
// ============================================================

function LeaveBalances() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [accrualOpen, setAccrualOpen] = useState(false);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (year.trim()) params.set('year', year.trim());
    if (leaveTypeId) params.set('leaveTypeId', leaveTypeId);
    api<{ data: Rec[] }>(`/api/ops/hcm/leave/balances?${params.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Leave balances failed'));
  }, [year, leaveTypeId]);
  useEffect(() => { load(); }, [load]);
  const typeOptions = Array.from(new Map(rows.map((r) => [Number(r.leaveTypeId), { id: Number(r.leaveTypeId), code: String(r.leaveTypeCode ?? ''), name: String(r.leaveTypeName ?? '') }])).values());
  const totalAvailable = rows.reduce((s, r) => s + Number(r.available ?? 0), 0);
  const totalAccrued = rows.reduce((s, r) => s + Number(r.accrued ?? 0), 0);
  const headcount = new Set(rows.map((r) => String(r.employeeId))).size;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Leave management</p>
          <h1>Leave balances</h1>
          <p className="muted">Opening balance, accruals, usage and available days per employee and leave type for the selected year.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people/leave')}>Requests</button>
          <button className="btn" onClick={() => navigate('/people/leave/calendar')}>Calendar</button>
          {can(user, 'hr.leave_accruals.accrue') && <button className="btn btn-primary" onClick={() => setAccrualOpen(true)}>Run accrual</button>}
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Employees with balances</span><span className="kpi-value">{fmtNum(headcount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Total accrued</span><span className="kpi-value">{fmtNum(totalAccrued)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Total available</span><span className="kpi-value">{fmtNum(totalAvailable)}</span></div>
      </div>
      <div className="toolbar">
        <div className="field" style={{ margin: 0 }}><label className="visually-hidden" htmlFor="bal-year">Year</label><input id="bal-year" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" style={{ width: 110 }} /></div>
        <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} aria-label="Filter by leave type">
          <option value="">All leave types</option>
          {typeOptions.map((t) => <option key={t.id} value={String(t.id)}>{t.code} - {t.name}</option>)}
        </select>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Employee</th><th>Type</th><th className="cell-num">Year</th><th className="cell-num">Opening</th><th className="cell-num">Accrued</th><th className="cell-num">Used</th><th className="cell-num">Adjusted</th><th className="cell-num">Available</th><th>Paid</th></tr></thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={String(r.id)}>
                <td><div className="cell-mono">{String(r.employeeNo ?? '')}</div><strong>{String(r.firstName ?? '')} {String(r.lastName ?? '')}</strong></td>
                <td>{String(r.leaveTypeName ?? r.leaveTypeCode ?? '-')}</td>
                <td className="cell-num">{fmtNum(r.year)}</td>
                <td className="cell-num">{fmtNum(r.openingBalance)}</td>
                <td className="cell-num">{fmtNum(r.accrued)}</td>
                <td className="cell-num">{fmtNum(r.used)}</td>
                <td className="cell-num">{fmtNum(r.adjusted)}</td>
                <td className="cell-num"><strong>{fmtNum(r.available)}</strong></td>
                <td>{String(r.isPaid) === 'true' ? 'Paid' : 'Unpaid'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No balances for the selected year. Run accrual to generate opening balances and entitlements.</td></tr>}
          </tbody>
        </table>
      </div>
      {accrualOpen && <AccrualModal onClose={() => setAccrualOpen(false)} onDone={(msg) => { setAccrualOpen(false); setNotice(msg); load(); }} />}
    </div>
  );
}

function AccrualModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      const res = await api<{ data: { lines?: unknown[]; year?: number } }>('/api/ops/hcm/leave/accrual/run', {
        method: 'POST',
        body: JSON.stringify({ year: year.trim() ? Number(year.trim()) : null }),
      });
      onDone(`Accrual complete for ${String(res.data.year ?? year)} - ${fmtNum((res.data.lines ?? []).length)} balances updated`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Run leave accrual" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Running...' : 'Run accrual'}</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <p className="muted" style={{ marginBottom: 12 }}>Accrues leave for all active employees for the selected year, per the configured leave types and accrual rules. The run is idempotent per year.</p>
      <div className="field"><label>Year</label><input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} /></div>
    </Modal>
  );
}

// ============================================================
// LEAVE CALENDAR
// ============================================================

type CalItem = {
  date: string;
  endDate?: string;
  type: 'HOLIDAY' | 'LEAVE';
  name?: string;
  recurring?: boolean;
  holidayId?: number;
  employeeNo?: string;
  leaveId?: number;
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDay(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function chipLabel(it: CalItem): string {
  const raw = it.type === 'HOLIDAY' ? String(it.name ?? 'Holiday') : String(it.name ?? it.employeeNo ?? 'Leave');
  return raw.length > 16 ? `${raw.slice(0, 15)}...` : raw;
}

function chipTitle(it: CalItem): string {
  const range = `${String(it.date).slice(0, 10)}${it.endDate ? ` - ${String(it.endDate).slice(0, 10)}` : ''}`;
  return `${String(it.name ?? it.type)} (${range})${it.employeeNo ? ` - ${String(it.employeeNo)}` : ''}`;
}

function LeaveCalendar() {
  const now = new Date();
  const [cursor, setCursor] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [items, setItems] = useState<CalItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback((ym: string) => {
    setLoading(true); setError('');
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    const padStart = new Date(first);
    padStart.setDate(first.getDate() - first.getDay());
    const padEnd = new Date(last);
    padEnd.setDate(last.getDate() + (6 - last.getDay()));
    const params = new URLSearchParams({
      startDate: isoDay(padStart.getFullYear(), padStart.getMonth() + 1, padStart.getDate()),
      endDate: isoDay(padEnd.getFullYear(), padEnd.getMonth() + 1, padEnd.getDate()),
    });
    api<{ data: { items?: CalItem[] } }>(`/api/ops/hcm/calendar?${params.toString()}`)
      .then((r) => setItems(r.data.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Leave calendar failed'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(cursor); }, [cursor, load]);
  if (loading) return <PageLoader label="Loading leave calendar" />;
  const [y, m] = cursor.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const title = first.toLocaleString('en-UG', { month: 'long', year: 'numeric' });
  const byDate: Record<string, CalItem[]> = {};
  for (const it of items) {
    const key = String(it.date).slice(0, 10);
    (byDate[key] = byDate[key] ?? []).push(it);
  }
  const inMonth = items.filter((it) => String(it.date).startsWith(cursor));
  const holidayCount = inMonth.filter((it) => it.type === 'HOLIDAY').length;
  const leaveCount = inMonth.filter((it) => it.type === 'LEAVE').length;
  const onLeaveCount = new Set(inMonth.filter((it) => it.type === 'LEAVE').map((it) => String(it.employeeNo ?? ''))).size;
  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setCursor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const cells: Array<{ key: string; day: number | null; chips: CalItem[] }> = [];
  for (let i = 0; i < startDow; i++) cells.push({ key: `pad-${i}`, day: null, chips: [] });
  for (let d = 1; d <= daysInMonth; d++) {
    const key = isoDay(y, m, d);
    cells.push({ key, day: d, chips: byDate[key] ?? [] });
  }
  const gridRows: Array<Array<{ key: string; day: number | null; chips: CalItem[] }>> = [];
  for (let i = 0; i < cells.length; i += 7) gridRows.push(cells.slice(i, i + 7));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Leave management</p>
          <h1>Leave calendar</h1>
          <p className="muted">Configured public holidays and approved leave across the company for the selected month.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people/leave')}>Requests</button>
          <button className="btn" onClick={() => navigate('/people/leave/balances')}>Balances</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Holidays</span><span className="kpi-value">{fmtNum(holidayCount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Leave entries</span><span className="kpi-value">{fmtNum(leaveCount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Employees on leave</span><span className="kpi-value">{fmtNum(onLeaveCount)}</span></div>
      </div>
      <div className="toolbar">
        <button className="btn btn-sm" onClick={() => shift(-1)} aria-label="Previous month">&larr; Prev</button>
        <strong style={{ minWidth: 180, textAlign: 'center' }}>{title}</strong>
        <button className="btn btn-sm" onClick={() => shift(1)} aria-label="Next month">Next &rarr;</button>
        <button className="btn btn-sm" onClick={() => { const t = new Date(); setCursor(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`); }}>Today</button>
      </div>
      <div className="card card-pad">
        <table className="cal-grid">
          <thead>
            <tr>{DOW_LABELS.map((d) => <th key={d}>{d}</th>)}</tr>
          </thead>
          <tbody>
            {gridRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c) => (
                  <td key={c.key} className={c.day === null ? 'cal-cell cal-cell-muted' : 'cal-cell'}>
                    {c.day !== null && (
                      <>
                        <div className="cal-num">{c.day}</div>
                        {c.chips.length > 0 && (
                          <div className="cal-chips">
                            {c.chips.slice(0, 3).map((it, i) => (
                              <span key={`${c.key}-${i}`} title={chipTitle(it)} className={'chip ' + (it.type === 'HOLIDAY' ? 'chip-holiday' : 'chip-leave')}>{chipLabel(it)}</span>
                            ))}
                            {c.chips.length > 3 && <span className="chip chip-more">+{c.chips.length - 3}</span>}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cal-legend">
          <span className="chip chip-holiday">Public holiday</span>
          <span className="chip chip-leave">Approved leave</span>
        </div>
      </div>
    </div>
  );
}
