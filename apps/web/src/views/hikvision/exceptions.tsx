import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Modal, Pager, PageLoader, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS,
  RAW_STATUS_TONE, EXCEPTION_STATUS_TONE, EXCEPTION_TYPE_LABEL, SEVERITY_TONE,
  ATT_STATUS_TONE as ATT_TONE,
  statusPill, empName, empNo, fmtWhen,
} from './shared';
import { Field, Inp, Sel, Txa, FormErr } from './fields';
import { qs, isoToday } from './hkutil';

const STATUS_OPTIONS = Object.keys(EXCEPTION_STATUS_TONE).map((s) => ({
  value: s,
  label: s.replace(/_/g, ' '),
}));
const TYPE_OPTIONS = Object.keys(EXCEPTION_TYPE_LABEL).map((t) => ({
  value: t,
  label: EXCEPTION_TYPE_LABEL[t],
}));
const SEV_OPTIONS = ['INFO', 'WARN', 'ERROR', 'CRITICAL'].map((s) => ({
  value: s,
  label: s[0] + s.slice(1).toLowerCase(),
}));

function typeLabel(t: unknown): string {
  const raw = toStr(t);
  return EXCEPTION_TYPE_LABEL[raw.toUpperCase()] ?? raw.replace(/_/g, ' ');
}

export default function ExceptionsCentre() {
  const { user } = useAuth();
  const canAssign = can(user, 'hikvision.exceptions.assign');
  const canResolve = can(user, 'hikvision.exceptions.resolve');
  const canApprove = can(user, 'hikvision.exceptions.approve');
  const canReject = can(user, 'hikvision.exceptions.reject');

  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [from, setFrom] = useState(isoToday());
  const [to, setTo] = useState(isoToday());
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [tick, setTick] = useState(0);

  const [detail, setDetail] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState('');
  const [panel, setPanel] = useState<'assign' | 'resolve' | 'approve' | 'reject' | 'map' | null>(null);
  const [text, setText] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [mapQ, setMapQ] = useState('');
  const [mapResults, setMapResults] = useState<Rec[]>([]);
  const [mapBusy, setMapBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = qs({
        status: status || undefined,
        exceptionType: type || undefined,
        severity: severity || undefined,
        dateFrom: from || undefined,
        dateTo: to || undefined,
        q: q.trim() || undefined,
        page,
        pageSize,
      });
      const r = await api<{ data: Rec }>('/api/hikvision/exceptions' + query);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exceptions failed to load');
    }
  }, [status, type, severity, from, to, q, page, pageSize]);
  useEffect(() => { void load(); }, [load, tick]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    setNote('');
    setFormErr('');
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/exceptions/' + id);
      setDetail(r.data);
      setPanel(null);
      setText('');
      setAssigneeId('');
      setMapQ('');
      setMapResults([]);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exception detail failed');
    } finally {
      setBusyId(null);
    }
  }, []);

  const runAction = async (id: string, action: string, body?: Record<string, unknown>) => {
    setBusy(true); setFormErr(''); setNote('');
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/exceptions/' + id + '/' + action, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      setDetail(r.data);
      setNote(
        action === 'resolve' ? 'Exception marked resolved.' :
        action === 'approve' ? 'Exception approved.' :
        action === 'reject' ? 'Exception rejected.' :
        action === 'reopen' ? 'Exception reopened.' :
        action === 'map-employee' ? 'Employee mapped. Raw event re-queued for processing.' : 'Action completed.'
      );
      setPanel(null);
      setText('');
      setAssigneeId('');
      setMapQ('');
      setMapResults([]);
      refresh();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const searchEmployees = async (textQ: string) => {
    setMapQ(textQ);
    if (!textQ.trim()) { setMapResults([]); return; }
    setMapBusy(true);
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/exceptions/employee-search?q=' + encodeURIComponent(textQ.trim()));
      setMapResults(((r.data?.items ?? []) as Rec[]) || []);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Employee search failed');
      setMapResults([]);
    } finally {
      setMapBusy(false);
    }
  };

  const items = ((data ?? {}).items ?? []) as Rec[];
  const total = toNum((data ?? {}).total);
  const exc = (detail?.exception ?? null) as Rec | null;
  const rawEv = (detail?.rawEvent ?? null) as Rec | null;
  const attRec = (detail?.attendanceRecord ?? null) as Rec | null;
  const audits = (detail?.auditHistory ?? []) as Rec[];
  const excStatus = pickS(exc, 'status');
  const excType = pickS(exc, 'exceptionType');

  const doAssign = () => {
    if (!exc) return;
    const idNum = Number(assigneeId.trim());
    if (!Number.isInteger(idNum) || idNum < 1) { setFormErr('Enter a valid assignee user id.'); return; }
    void runAction(toStr(exc.id), 'assign', { assignedToUserId: idNum });
  };
  const doResolve = () => {
    if (!exc) return;
    if (!text.trim()) { setFormErr('A resolution note is required.'); return; }
    void runAction(toStr(exc.id), 'resolve', { resolution: text.trim() });
  };
  const doApprove = () => {
    if (!exc) return;
    void runAction(toStr(exc.id), 'approve', text.trim() ? { resolution: text.trim() } : {});
  };
  const doReject = () => {
    if (!exc) return;
    if (!text.trim()) { setFormErr('A rejection reason is required.'); return; }
    void runAction(toStr(exc.id), 'reject', { reason: text.trim() });
  };
  const doMap = (employeeId: string) => {
    if (!exc) return;
    void runAction(toStr(exc.id), 'map-employee', { employeeId: Number(employeeId), resolution: text.trim() || undefined });
  };

  return (
    <div className="page">
      <HikHead
        title="Attendance Exceptions"
        subtitle="Review, assign, resolve and approve attendance exceptions raised by the processing engine."
      />
      <HikTabs active="exceptions" />
      {note ? (
        <div className="notice-banner" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{note}</span>
          <button type="button" className="modal-close" onClick={() => setNote('')} aria-label="Dismiss">{'\u2715'}</button>
        </div>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}

      <div className="hk-toolbar">
        <Field label="Status">
          <Sel value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} placeholder="All statuses" />
        </Field>
        <Field label="Type">
          <Sel value={type} onChange={(v) => { setType(v); setPage(1); }} options={TYPE_OPTIONS} placeholder="All types" />
        </Field>
        <Field label="Severity">
          <Sel value={severity} onChange={(v) => { setSeverity(v); setPage(1); }} options={SEV_OPTIONS} placeholder="All severities" />
        </Field>
        <Field label="From">
          <Inp type="date" value={from} onChange={(v) => { setFrom(v); setPage(1); }} />
        </Field>
        <Field label="To">
          <Inp type="date" value={to} onChange={(v) => { setTo(v); setPage(1); }} />
        </Field>
        <div className="hk-search">
          <span className="hk-lbl">Search</span>
          <input className="hk-input" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); void load(); } }}
            placeholder="Summary, employee or device" />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => { setPage(1); void load(); }}>Apply</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setStatus(''); setType(''); setSeverity(''); setFrom(isoToday()); setTo(isoToday()); setQ(''); setPage(1); }}>Reset</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{total} exception{total === 1 ? '' : 's'}</span>
      </div>

      {!data ? (
        <PageLoader label="Loading exceptions..." />
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>No exceptions found</h3>
          <p>Adjust your filters, or check back once the attendance engine raises new exceptions.</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Exception</th>
                  <th>Employee</th>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => {
                  const id = toStr(x.id);
                  const emp = (x.employee ?? null) as Rec | null;
                  const dev = (x.device ?? null) as Rec | null;
                  return (
                    <tr key={id}>
                      <td>
                        <div style={{ maxWidth: 380 }}>{toStr(x.summary) || typeLabel(x.exceptionType)}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{toStr(x.employeeIdentifier) || 'no identifier'} {'\u2022'} {fmtWhen(x.eventTime || x.createdAt)}</div>
                      </td>
                      <td>
                        {emp ? (
                          <div>
                            <div>{empName(emp)}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{empNo(emp)}</div>
                          </div>
                        ) : (
                          <span className="hk-drift-bad">Not mapped</span>
                        )}
                      </td>
                      <td>
                        <div>{pickS(dev, 'name') || 'Terminal'}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{pickS(dev, 'location')}</div>
                      </td>
                      <td><span className="badge badge-neutral">{typeLabel(x.exceptionType)}</span></td>
                      <td>{statusPill(x.severity, SEVERITY_TONE)}</td>
                      <td>{statusPill(x.status, EXCEPTION_STATUS_TONE)}</td>
                      <td>
                        {pickS(x, 'assignee') ? pickS((x.assignee as Rec | null), 'name') : <span className="muted">Unassigned</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn-sm" disabled={busyId === id} onClick={() => void openDetail(id)}>
                          {busyId === id ? 'Loading...' : 'Review'}
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
      {detail && exc ? (
        <Modal
          title={'Exception #' + toStr(exc.id) + ' - ' + typeLabel(exc.exceptionType)}
          onClose={() => setDetail(null)}
          wide
          footer={
            <div className="hk-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm" onClick={() => setDetail(null)}>Close</button>
              {canAssign && excStatus !== 'APPROVED' && excStatus !== 'REJECTED' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPanel(panel === 'assign' ? null : 'assign'); setFormErr(''); setText(''); }}>Assign</button>
              ) : null}
              {canResolve && excType === 'UNKNOWN_EMPLOYEE' && excStatus !== 'APPROVED' && excStatus !== 'REJECTED' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPanel(panel === 'map' ? null : 'map'); setFormErr(''); }}>Map employee</button>
              ) : null}
              {canResolve && excStatus !== 'APPROVED' && excStatus !== 'REJECTED' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPanel(panel === 'resolve' ? null : 'resolve'); setFormErr(''); setText(''); }}>Resolve</button>
              ) : null}
              {canApprove && excStatus !== 'APPROVED' && excStatus !== 'REJECTED' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPanel(panel === 'approve' ? null : 'approve'); setFormErr(''); setText(''); }}>Approve</button>
              ) : null}
              {canReject && excStatus !== 'APPROVED' ? (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setPanel(panel === 'reject' ? null : 'reject'); setFormErr(''); setText(''); }}>Reject</button>
              ) : null}
              {canResolve && (excStatus === 'RESOLVED' || excStatus === 'APPROVED' || excStatus === 'REJECTED') ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runAction(toStr(exc.id), 'reopen')}>Reopen</button>
              ) : null}
            </div>
          }
        >
          {formErr ? <FormErr msg={formErr} /> : null}
          {note ? <div className="notice-banner">{note}</div> : null}
          <div className="section-title">Exception details</div>
          <p style={{ margin: '0 0 12px', lineHeight: 1.55 }}>{toStr(exc.summary) || 'No summary supplied.'}</p>
          <div className="kv-grid">
            <div className="kv"><span className="kv-k">Status</span><span className="kv-v">{statusPill(exc.status, EXCEPTION_STATUS_TONE)}</span></div>
            <div className="kv"><span className="kv-k">Severity</span><span className="kv-v">{statusPill(exc.severity, SEVERITY_TONE)}</span></div>
            <div className="kv"><span className="kv-k">Event time</span><span className="kv-v">{fmtWhen(exc.eventTime || exc.createdAt)}</span></div>
            <div className="kv"><span className="kv-k">Employee identifier</span><span className="kv-v">{toStr(exc.employeeIdentifier) || '-'}</span></div>
            <div className="kv"><span className="kv-k">Raw event</span><span className="kv-v">#{toStr(exc.rawEventId) || '-'}</span></div>
            <div className="kv"><span className="kv-k">Attendance record</span><span className="kv-v">#{toStr(exc.attendanceRecordId) || '-'}</span></div>
            <div className="kv"><span className="kv-k">Created</span><span className="kv-v">{fmtWhen(exc.createdAt)}</span></div>
            <div className="kv"><span className="kv-k">Assigned to</span><span className="kv-v">{pickS((exc.assignee as Rec | null) ?? null, 'name') || 'Unassigned'}</span></div>
            <div className="kv"><span className="kv-k">Resolved by</span><span className="kv-v">{toStr(exc.resolvedByName) || '-'}</span></div>
            <div className="kv"><span className="kv-k">Resolution</span><span className="kv-v">{toStr(exc.resolution) || '-'}</span></div>
          </div>
          {rawEv ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Raw event</div>
              <div className="kv-grid">
                <div className="kv"><span className="kv-k">Payload format</span><span className="kv-v">{toStr(rawEv.payload_format).toUpperCase()}</span></div>
                <div className="kv"><span className="kv-k">Processing status</span><span className="kv-v">{statusPill(rawEv.processing_status, RAW_STATUS_TONE)}</span></div>
                <div className="kv"><span className="kv-k">Received</span><span className="kv-v">{fmtWhen(rawEv.received_at)}</span></div>
                <div className="kv"><span className="kv-k">Device event time</span><span className="kv-v">{fmtWhen(rawEv.device_event_time)}</span></div>
              </div>
              {rawEv.payload ? <pre className="json-pre" style={{ marginTop: 8 }}>{JSON.stringify(rawEv.payload, null, 2)}</pre> : null}
            </>
          ) : null}
          {attRec ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Attendance record</div>
              <div className="kv-grid">
                <div className="kv"><span className="kv-k">Work date</span><span className="kv-v">{toStr(attRec.work_date)}</span></div>
                <div className="kv"><span className="kv-k">Shift code</span><span className="kv-v">{toStr(attRec.shift_code) || '-'}</span></div>
                <div className="kv"><span className="kv-k">Check in</span><span className="kv-v">{fmtWhen(attRec.check_in)}</span></div>
                <div className="kv"><span className="kv-k">Check out</span><span className="kv-v">{fmtWhen(attRec.check_out)}</span></div>
                <div className="kv"><span className="kv-k">Status</span><span className="kv-v">{statusPill(attRec.attendance_status, ATT_TONE)}</span></div>
                <div className="kv"><span className="kv-k">Approval</span><span className="kv-v">{toStr(attRec.approval_status)}</span></div>
              </div>
            </>
          ) : null}
          {panel === 'assign' ? (
            <div className="hk-warn-bar" style={{ marginTop: 14 }}>
              <div className="section-title" style={{ margin: '0 0 8px' }}>Assign exception</div>
              <Field label="Assignee user id" req hint="User ids are tenant users in HOPE DESIGN. Enter the reviewer's numeric user id.">
                <Inp value={assigneeId} onChange={setAssigneeId} placeholder="e.g. 42" />
              </Field>
              <div className="hk-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busy || !assigneeId.trim()} onClick={doAssign}>Assign</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {panel === 'resolve' ? (
            <div className="hk-warn-bar" style={{ marginTop: 14 }}>
              <div className="section-title" style={{ margin: '0 0 8px' }}>Resolve exception</div>
              <Field label="Resolution note" req>
                <Txa value={text} onChange={setText} placeholder="What action was taken? This is recorded in the audit trail." />
              </Field>
              <div className="hk-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busy || !text.trim()} onClick={doResolve}>Mark resolved</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {panel === 'approve' ? (
            <div className="hk-warn-bar" style={{ marginTop: 14 }}>
              <div className="section-title" style={{ margin: '0 0 8px' }}>Approve exception</div>
              <p className="hk-note" style={{ marginBottom: 8 }}>Approving confirms the resolution. An optional note is kept with the exception.</p>
              <Field label="Approval note (optional)">
                <Txa value={text} onChange={setText} placeholder="Optional note for the approval decision." />
              </Field>
              <div className="hk-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={doApprove}>Approve</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {panel === 'reject' ? (
            <div className="hk-warn-bar" style={{ marginTop: 14 }}>
              <div className="section-title" style={{ margin: '0 0 8px' }}>Reject exception</div>
              <Field label="Rejection reason" req>
                <Txa value={text} onChange={setText} placeholder="Why is this exception rejected?" />
              </Field>
              <div className="hk-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy || !text.trim()} onClick={doReject}>Reject</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {panel === 'map' ? (
            <div className="hk-warn-bar" style={{ marginTop: 14 }}>
              <div className="section-title" style={{ margin: '0 0 4px' }}>Map employee to identifier {toStr(exc.employeeIdentifier)}</div>
              <p className="hk-note" style={{ marginBottom: 8 }}>
                Mapping never creates an HR record. Selecting an existing employee creates a device link, back-fills the canonical
                event and re-queues the preserved raw event so the engine re-evaluates it.
              </p>
              <div className="hk-inline" style={{ marginBottom: 8 }}>
                <div className="hk-search">
                  <span className="hk-lbl">Search employees</span>
                  <input className="hk-input" value={mapQ} onChange={(e) => void searchEmployees(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void searchEmployees(mapQ); }}
                    placeholder="Employee number, name, position" />
                </div>
                {mapBusy ? <span className="muted">Searching...</span> : null}
              </div>
              {mapResults.length > 0 ? (
                <div className="table-wrap">
                  <table className="mini-table">
                    <thead>
                      <tr><th>Employee</th><th>Position</th><th>Branch / department</th><th>Status</th><th></th></tr>
                    </thead>
                    <tbody>
                      {mapResults.map((emp) => (
                        <tr key={toStr(emp.id)}>
                          <td>
                            <div>{toStr(emp.name)}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{toStr(emp.employeeNo)}</div>
                          </td>
                          <td>{toStr(emp.position) || '-'}</td>
                          <td>
                            <div>{toStr(emp.branchName) || '-'}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{toStr(emp.departmentName) || '-'}</div>
                          </td>
                          <td><span className="muted">{toStr(emp.status) || '-'}</span></td>
                          <td>
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void doMap(toStr(emp.id))}>Map</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : mapQ.trim() && !mapBusy ? (
                <p className="hk-note">No employees match that search.</p>
              ) : null}
              <div className="hk-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {audits.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Audit trail</div>
              <div className="table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr><th>Action</th><th>User</th><th>IP</th><th>Change</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {audits.map((a) => (
                      <tr key={toStr(a.created_at) + toStr(a.action) + toStr(a.record_id ?? '')}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{toStr(a.action)}</td>
                        <td>{toStr(a.user_id)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{toStr(a.ip)}</td>
                        <td style={{ fontSize: 11.5 }}>{(toStr(a.old_values).slice(0, 40) || '-') + ' -> ' + (toStr(a.new_values).slice(0, 40) || '-')}</td>
                        <td><span className="muted">{fmtWhen(a.created_at)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <p className="hk-note" style={{ marginTop: 14 }}>
            Every review action is written to the audit trail. Approved exceptions feed the attendance approval flow;
            rejected exceptions can be reopened when new information arrives.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
