import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Modal, Pager, PageLoader, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS,
  RAW_STATUS_TONE, EVENT_TYPE_LABEL, SEVERITY_TONE as SEV_TONE,
  statusPill, verifPill, fmtWhen, empName, empNo, MiniAvatar, pickB,
} from './shared';
import { Field, Inp, Sel, Txa, FormErr } from './fields';
import { qs, isoToday, isoDaysAgo } from './hkutil';

const EV_STATUSES = Object.keys(RAW_STATUS_TONE);
const EV_STATUS_OPTIONS = EV_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));
const FORMAT_OPTIONS = [
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'form', label: 'Form' },
];

function pretty(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function typeLabel(raw: unknown): string {
  const s = toStr(raw);
  return EVENT_TYPE_LABEL[s.toUpperCase()] ?? s.replace(/_/g, ' ');
}

export default function EventsView({ failed }: { failed: boolean }) {
  const { user } = useAuth();
  const canRetry = can(user, 'hikvision.events.retry');
  const canReprocess = can(user, 'hikvision.events.reprocess');
  const canReject = can(user, 'hikvision.events.reject');

  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [format, setFormat] = useState('');
  const [serial, setSerial] = useState('');
  const [employeeIdentifier, setEmployeeIdentifier] = useState('');
  const [from, setFrom] = useState(failed ? isoDaysAgo(7) : isoToday());
  const [to, setTo] = useState(isoToday());
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [tick, setTick] = useState(0);

  const [detail, setDetail] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [formErr, setFormErr] = useState('');
  const [note, setNote] = useState('');
  const [payloadOpen, setPayloadOpen] = useState(false);

  const base = failed ? '/api/hikvision/events/failed' : '/api/hikvision/events';
  const load = useCallback(async () => {
    try {
      const query = qs({
        status: failed ? undefined : status || undefined,
        format: format || undefined,
        serial: serial.trim() || undefined,
        employeeIdentifier: employeeIdentifier.trim() || undefined,
        dateFrom: from || undefined,
        dateTo: to || undefined,
        q: q.trim() || undefined,
        page,
        pageSize,
      });
      const r = await api<{ data: Rec }>(base + query);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Events failed to load');
    }
  }, [base, failed, status, format, serial, employeeIdentifier, from, to, q, page, pageSize]);
  useEffect(() => { void load(); }, [load, tick]);

  const openDetail = useCallback(async (id: string) => {
    setBusyId(id);
    setPayloadOpen(false);
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/events/' + id);
      setDetail(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Event detail failed');
    } finally {
      setBusyId(null);
    }
  }, []);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const postAction = async (id: string, action: string, body?: Record<string, unknown>) => {
    setBusy(true); setFormErr(''); setNote('');
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/events/' + id + '/' + action, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      setDetail(null);
      refresh();
      setNote(toStr(r.data.message) || (action[0].toUpperCase() + action.slice(1) + ' requested.'));
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  const items = ((data ?? {}).items ?? []) as Rec[];
  const total = toNum((data ?? {}).total);
  const det = (detail?.event ?? null) as Rec | null;
  const payload = detail?.payload ?? null;
  const norm = (detail?.normalized ?? null) as Rec | null;
  const punches = (detail?.punches ?? []) as Rec[];
  const xcptns = (detail?.exceptions ?? []) as Rec[];
  const errs = (detail?.integrationErrors ?? []) as Rec[];
  const audits = (detail?.auditHistory ?? []) as Rec[];
  const detStatus = pickS(det, 'processingStatus');

  return (
    <div className="page">
      <HikHead
        title={failed ? 'Failed Events' : 'Event Journal'}
        subtitle={
          failed
            ? 'Raw events that failed processing. Inspect, retry, reprocess or reject without ever deleting an event.'
            : 'Validated device events with full raw payloads, normalization, punches and audit history.'
        }
        actions={
          <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy}>Refresh</button>
        }
      />
      <HikTabs active={failed ? 'failed' : 'events'} />
      {note ? (
        <div className="notice-banner" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{note}</span>
          <button type="button" className="modal-close" onClick={() => setNote('')} aria-label="Dismiss">{'\u2715'}</button>
        </div>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}

      <div className="hk-toolbar">
        {!failed ? (
          <Field label="Status">
            <Sel value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={EV_STATUS_OPTIONS} placeholder="All statuses" />
          </Field>
        ) : null}
        <Field label="Format">
          <Sel value={format} onChange={(v) => { setFormat(v); setPage(1); }} options={FORMAT_OPTIONS} placeholder="All formats" />
        </Field>
        <Field label="Serial">
          <Inp value={serial} onChange={setSerial} placeholder="DSK1T-XXXX" />
        </Field>
        <Field label="Employee number">
          <Inp value={employeeIdentifier} onChange={setEmployeeIdentifier} placeholder="HDG-EMP-..." />
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
            placeholder="Device, serial or employee" />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => { setPage(1); void load(); }}>Apply</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setStatus(''); setFormat(''); setSerial(''); setEmployeeIdentifier(''); setFrom(failed ? isoDaysAgo(7) : isoToday()); setTo(isoToday()); setQ(''); setPage(1); }}>Reset</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{total} event{total === 1 ? '' : 's'}</span>
      </div>

      {!data ? (
        <PageLoader label="Loading events..." />
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>{failed ? 'No failed events' : 'No events recorded'}</h3>
          <p>{failed ? 'Nothing has failed. New processing errors will land here for review.' : 'Events received from registered terminals will appear here after the secure receiver stores them.'}</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Event / received</th>
                  <th>Device</th>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Device time</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const id = toStr(e.id);
                  const emp = (e.employee ?? null) as Rec | null;
                  const dev = (e.device ?? null) as Rec | null;
                  const rawType = toStr(e.normalizedType || e.eventType);
                  const busy = busyId === id;
                  return (
                    <tr key={id}>
                      <td>
                        <div className="hk-avatar-row">
                          <MiniAvatar name={pickS(dev, 'name') || 'EV'} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>#{id} <span className="muted" style={{ fontWeight: 400 }}>{toStr(e.payloadFormat).toUpperCase()}</span></div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{fmtWhen(e.receivedAt)}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div>{pickS(dev, 'name') || pickS(e, 'deviceSerialNumber') || 'Terminal'}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{pickS(dev, 'location')}</div>
                      </td>
                      <td>
                        {emp ? (
                          <div>
                            <div>{empName(emp)}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{empNo(emp)}</div>
                          </div>
                        ) : (
                          <div>
                            <div className="hk-drift-bad">{'\u26A0'} Unmapped</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{pickS(e, 'employeeIdentifier') || 'no identifier'}</div>
                          </div>
                        )}
                      </td>
                      <td>
                        <div>{typeLabel(rawType)}</div>
                        <div style={{ marginTop: 3 }}>{verifPill(e.verificationMethod)}</div>
                      </td>
                      <td><span className="muted">{fmtWhen(e.deviceEventTime)}</span></td>
                      <td>{statusPill(e.processingStatus, RAW_STATUS_TONE)}</td>
                      <td>
                        <div>{toNum(e.retryCount)}x</div>
                        {toStr(e.lastError) ? <div className="muted" style={{ fontSize: 11 }} title={toStr(e.lastError)}>{toStr(e.lastError).slice(0, 40)}</div> : null}
                      </td>
                      <td><span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(e, 'sourceIp')}</span></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void openDetail(id)}>
                          {busy ? 'Loading...' : 'View'}
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
      {detail && det ? (
        <Modal
          title={'Event #' + pickS(det, 'id') + ' - raw journal'}
          onClose={() => setDetail(null)}
          wide
          footer={
            <div className="hk-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm" onClick={() => { setDetail(null); setNote(''); setFormErr(''); }}>Close</button>
              {canRetry && detStatus !== 'PROCESSING' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void postAction(pickS(det, 'id'), 'retry')}>Retry</button>
              ) : null}
              {canReprocess && detStatus !== 'PROCESSING' ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void postAction(pickS(det, 'id'), 'reprocess')}>Reprocess</button>
              ) : null}
              {canReject && detStatus !== 'PROCESSING' && detStatus !== 'REJECTED' ? (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setRejectId(pickS(det, 'id'))}>Reject event</button>
              ) : null}
            </div>
          }
        >
          {formErr ? <FormErr msg={formErr} /> : null}
          {note ? <div className="notice-banner">{note}</div> : null}
          <div className="section-title">Event details</div>
          <div className="kv-grid">
            <div className="kv"><span className="kv-k">Status</span><span className="kv-v">{statusPill(det.processingStatus, RAW_STATUS_TONE)}</span></div>
            <div className="kv"><span className="kv-k">Raw event type</span><span className="kv-v">{typeLabel(pickS(det, 'eventType'))}</span></div>
            <div className="kv"><span className="kv-k">Normalized type</span><span className="kv-v">{typeLabel(pickS(det, 'normalizedType'))}</span></div>
            <div className="kv"><span className="kv-k">Verification</span><span className="kv-v">{verifPill(det.verificationMethod)}</span></div>
            <div className="kv"><span className="kv-k">Employee number</span><span className="kv-v">{pickS(det, 'employeeIdentifier')}</span></div>
            <div className="kv"><span className="kv-k">Payload format</span><span className="kv-v">{toStr(det.payloadFormat).toUpperCase()}</span></div>
            <div className="kv"><span className="kv-k">Received at</span><span className="kv-v">{fmtWhen(det.receivedAt)}</span></div>
            <div className="kv"><span className="kv-k">Device event time</span><span className="kv-v">{fmtWhen(det.deviceEventTime)}</span></div>
            <div className="kv"><span className="kv-k">Device serial</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(det, 'deviceSerialNumber')}</span></div>
            <div className="kv"><span className="kv-k">Source IP</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(det, 'sourceIp')}</span></div>
            <div className="kv"><span className="kv-k">Retry count</span><span className="kv-v">{toNum(det.retryCount)}</span></div>
            <div className="kv"><span className="kv-k">Dedupe key</span><span className="kv-v" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(det, 'dedupeKey') || '-'}</span></div>
          </div>
          {toStr(det.errorMessage) ? (
            <div className="hk-warn-bar" style={{ marginTop: 12 }}>
              <strong>Last error: </strong>
              {toStr(det.errorMessage)}
            </div>
          ) : null}
          <div className="section-title" style={{ marginTop: 18 }}>Raw payload</div>
          <div className="hk-inline" style={{ marginBottom: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setPayloadOpen(!payloadOpen)}>
              {payloadOpen ? 'Hide raw payload' : 'Show raw payload'}
            </button>
            {payloadOpen ? <span className="muted">Exact bytes preserved at {fmtWhen(det.receivedAt)} - never edited in place.</span> : null}
          </div>
          {payloadOpen ? <pre className="json-pre">{pretty(payload)}</pre> : null}
          {norm ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Normalized event</div>
              <div className="kv-grid">
                <div className="kv"><span className="kv-k">Event type</span><span className="kv-v">{typeLabel(pickS(norm, 'event_type'))}</span></div>
                <div className="kv"><span className="kv-k">Verification</span><span className="kv-v">{verifPill(norm.verification_method)}</span></div>
                <div className="kv"><span className="kv-k">Employee identifier</span><span className="kv-v">{pickS(norm, 'employee_identifier')}</span></div>
                <div className="kv"><span className="kv-k">Location</span><span className="kv-v">{pickS(norm, 'location')}</span></div>
                <div className="kv"><span className="kv-k">Event time</span><span className="kv-v">{fmtWhen(norm.event_time)}</span></div>
                <div className="kv"><span className="kv-k">Device serial</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(norm, 'device_serial_number')}</span></div>
              </div>
            </>
          ) : null}
          {punches.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Attendance punches</div>
              <div className="table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr><th>Punch time</th><th>Type</th><th>Verification</th><th>Purpose</th><th>Location</th><th>Segment</th><th>Record</th></tr>
                  </thead>
                  <tbody>
                    {punches.map((pu) => (
                      <tr key={toStr(pu.id)}>
                        <td>{fmtWhen(pu.punch_time)}</td>
                        <td>{typeLabel(pu.punch_type)}</td>
                        <td>{verifPill(pu.verification_method)}</td>
                        <td>{typeLabel(pu.device_purpose)}</td>
                        <td>{pickS(pu, 'location')}</td>
                        <td>{pickS(pu, 'segment')}</td>
                        <td>{pickS(pu, 'attendance_record_id') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {xcptns.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Exceptions raised</div>
              <div className="table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr><th>Type</th><th>Severity</th><th>Status</th><th>Summary</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {xcptns.map((x) => (
                      <tr key={toStr(x.id)}>
                        <td>{typeLabel(x.exception_type)}</td>
                        <td>{statusPill(x.severity, SEV_TONE)}</td>
                        <td>{pickS(x, 'status')}</td>
                        <td>{pickS(x, 'summary')}</td>
                        <td><span className="muted">{fmtWhen(x.created_at)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {errs.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 18 }}>Integration errors</div>
              <div className="table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr><th>Stage</th><th>Code</th><th>Message</th><th>Created</th><th>Resolved</th></tr>
                  </thead>
                  <tbody>
                    {errs.map((er) => (
                      <tr key={toStr(er.id)}>
                        <td>{pickS(er, 'stage')}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(er, 'error_code')}</td>
                        <td>{pickS(er, 'error_message')}</td>
                        <td><span className="muted">{fmtWhen(er.created_at)}</span></td>
                        <td>{pickB(er, 'resolved') ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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
                      <tr key={toStr(a.created_at) + toStr(a.action) + toStr(a.record_id)}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(a, 'action')}</td>
                        <td>{pickS(a, 'user_id')}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(a, 'ip')}</td>
                        <td style={{ fontSize: 11.5 }} title={pretty({ old: a.old_values, new: a.new_values })}>{(toStr(a.old_values).slice(0, 40) || '-') + ' -> ' + (toStr(a.new_values).slice(0, 40) || '-')}</td>
                        <td><span className="muted">{fmtWhen(a.created_at)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <p className="hk-note" style={{ marginTop: 14 }}>
            Raw events are preserved for audit and are never deleted. Retry requeues the event for the worker;
            reprocess also clears any duplicate marker so the event is evaluated again.
          </p>
        </Modal>
      ) : null}
      {rejectId ? (
        <Modal
          title={'Reject event #' + rejectId}
          onClose={() => { setRejectId(null); setRejectReason(''); setFormErr(''); }}
          footer={
            <div className="hk-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm" onClick={() => { setRejectId(null); setRejectReason(''); setFormErr(''); }}>Cancel</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy || !rejectReason.trim()}
                onClick={() => {
                  void postAction(rejectId, 'reject', { reason: rejectReason.trim() });
                  setRejectId(null);
                  setRejectReason('');
                }}>
                Reject event
              </button>
            </div>
          }
        >
          <p className="hk-note">
            Rejecting marks the event {statusPill('REJECTED', RAW_STATUS_TONE)} in the raw journal. The event is never deleted
            and the rejection reason is written to the audit trail.
          </p>
          <Field label="Rejection reason" req>
            <Txa value={rejectReason} onChange={setRejectReason} placeholder="Why is this event rejected? (recorded in audit)" />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
