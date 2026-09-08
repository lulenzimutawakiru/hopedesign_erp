import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Modal, Pager, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS, pickN,
  VERIF_LABEL, statusPill, fmtWhen, empName, empNo, MiniAvatar,
} from './shared';
import { Field, Inp, Sel, Txa, FormErr, Saved } from './fields';
import { qs } from './hkutil';

const LINK_STATUS_TONE: Record<string, string> = {
  ACTIVE: 'badge-green',
  SUSPENDED: 'badge-amber',
  INACTIVE: 'badge-neutral',
};
const LINK_STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];
const LINK_STATUS_OPTIONS = LINK_STATUSES.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));
const VERIFY_OPTIONS = Object.keys(VERIF_LABEL).map((v) => ({ value: v, label: VERIF_LABEL[v] }));
const SYNC_TONE: Record<string, string> = {
  SUCCESS: 'badge-green',
  PARTIAL: 'badge-amber',
  FAILED: 'badge-red',
  SKIPPED: 'badge-neutral',
};
const ACTION_LABEL: Record<string, string> = {
  SYNC_EMPLOYEE: 'Sync employee',
  SYNC_SELECTED: 'Sync selected',
  BULK_SYNC: 'Bulk sync',
  DEACTIVATE_EMPLOYEE: 'Deactivate',
  DISABLE_ACCESS: 'Disable access',
  REMOVE_DEVICE_ACCESS: 'Remove access',
  TIME_SYNC: 'Time sync',
};
const ACTION_OPTIONS = Object.keys(ACTION_LABEL).map((a) => ({ value: a, label: ACTION_LABEL[a] }));
const SYNC_STATUS_OPTIONS = ['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));

interface LinkRow extends Rec {
  id: number;
  employee?: Rec | null;
  device?: Rec | null;
}

function linkPill(v: unknown) {
  return statusPill(v, LINK_STATUS_TONE, { ACTIVE: 'Active', SUSPENDED: 'Suspended', INACTIVE: 'Inactive' });
}

export default function SyncCentre() {
  const { user } = useAuth();
  const canCreateLink = can(user, 'hikvision.employee_links.create');
  const canUpdateLink = can(user, 'hikvision.employee_links.update');
  const canDeleteLink = can(user, 'hikvision.employee_links.delete');
  const canSync = can(user, 'hikvision.sync.employee');
  const canBulk = can(user, 'hikvision.sync.bulk');
  const canRemove = can(user, 'hikvision.sync.remove_access');

  const [tab, setTab] = useState<'links' | 'logs' | 'provision'>('links');

  // ---- links list ----
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [linkStatus, setLinkStatus] = useState('');
  const [linkQ, setLinkQ] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  // ---- new mapping modal ----
  const [createOpen, setCreateOpen] = useState(false);
  const [mkEmployeeId, setMkEmployeeId] = useState('');
  const [mkDeviceId, setMkDeviceId] = useState('');
  const [mkIdentifier, setMkIdentifier] = useState('');
  const [mkMethod, setMkMethod] = useState('UNKNOWN');
  const [mkStatus, setMkStatus] = useState('ACTIVE');
  const [mkNotes, setMkNotes] = useState('');
  const [empQ, setEmpQ] = useState('');
  const [empRows, setEmpRows] = useState<Rec[]>([]);
  const [empBusy, setEmpBusy] = useState(false);
  const [devices, setDevices] = useState<Rec[]>([]);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  // ---- provisioning ----
  const [bulkDevice, setBulkDevice] = useState('');
  const [bulkLimit, setBulkLimit] = useState('200');
  const [result, setResult] = useState<Rec | null>(null);

  // ---- logs ----
  const [logs, setLogs] = useState<Rec[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsAction, setLogsAction] = useState('');
  const [logsStatus, setLogsStatus] = useState('');
  const [logsDevice, setLogsDevice] = useState('');
  const [logsQ, setLogsQ] = useState('');

  const loadDevices = useCallback(async () => {
    try {
      const r = await api<{ data: { items: Rec[] } }>('/api/hikvision/devices?pageSize=500');
      setDevices((r.data.items ?? []) as Rec[]);
    } catch { setDevices([]); }
  }, []);

  const loadLinks = useCallback(async () => {
    try {
      const query = qs({ status: linkStatus || undefined, q: linkQ.trim() || undefined, page, pageSize });
      const r = await api<{ data: { items: Rec[]; total: number } }>('/api/hikvision/links' + query);
      setLinks((r.data.items ?? []) as LinkRow[]);
      setTotal(toNum(r.data.total));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Links failed to load');
    }
  }, [linkStatus, linkQ, page, pageSize]);

  const loadLogs = useCallback(async () => {
    try {
      const query = qs({
        action: logsAction || undefined,
        status: logsStatus || undefined,
        deviceId: logsDevice || undefined,
        employeeId: logsQ ? toNum(logsQ) || undefined : undefined,
        page: logsPage, pageSize: 25,
      });
      const r = await api<{ data: { items: Rec[]; total: number } }>('/api/hikvision/sync/logs' + query);
      setLogs((r.data.items ?? []) as Rec[]);
      setLogsTotal(toNum(r.data.total));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync logs failed to load');
    }
  }, [logsAction, logsStatus, logsDevice, logsQ, logsPage]);

  useEffect(() => { void loadDevices(); }, [loadDevices]);
  useEffect(() => { if (tab === 'links') void loadLinks(); }, [tab, loadLinks]);
  useEffect(() => { if (tab === 'logs') void loadLogs(); }, [tab, loadLogs]);

  const searchEmployees = async (textQ: string) => {
    setEmpQ(textQ);
    if (!textQ.trim()) { setEmpRows([]); return; }
    setEmpBusy(true);
    try {
      const r = await api<{ data: { rows: Rec[] } }>(
        '/api/ops/hr/employees?q=' + encodeURIComponent(textQ.trim()) + '&page=1&pageSize=10'
      );
      setEmpRows(r.data.rows ?? []);
    } catch { setEmpRows([]); } finally { setEmpBusy(false); }
  };

  const openCreate = () => {
    setCreateOpen(true); setFormErr(''); setNote('');
    setMkEmployeeId(''); setMkIdentifier(''); setMkMethod('UNKNOWN');
    setMkStatus('ACTIVE'); setMkNotes(''); setEmpQ(''); setEmpRows([]);
  };

  const pickEmployee = (row: Rec) => {
    setMkEmployeeId(toStr(pickN(row, 'id')) || toStr(row['id']));
    const no = empNo(row) || pickS(row, 'short_employee_number');
    if (no) setMkIdentifier(no);
  };

  const createLink = async () => {
    setBusy(true); setFormErr(''); setNote('');
    try {
      await api('/api/hikvision/links', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(mkEmployeeId),
          deviceId: mkDeviceId ? Number(mkDeviceId) : undefined,
          employeeIdentifier: mkIdentifier.trim(),
          verificationMethod: mkMethod,
          status: mkStatus,
          notes: mkNotes.trim() || undefined,
        }),
      });
      setNote('Employee mapped to the Hikvision terminal. The device now accepts that identifier for this employee.');
      setCreateOpen(false);
      await loadLinks();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Mapping failed');
    } finally { setBusy(false); }
  };

  const setLinkStatusRow = async (link: LinkRow, nextStatus: string) => {
    setBusy(true); setError('');
    try {
      await api('/api/hikvision/links/' + link.id, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setNote('Mapping for ' + empName(link.employee) + ' is now ' + nextStatus.toLowerCase() + '.');
      await loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status update failed');
    } finally { setBusy(false); }
  };

  const deleteLink = async (link: LinkRow) => {
    if (!window.confirm('Remove access mapping for ' + empName(link.employee) + '? This does not delete the employee.')) return;
    setBusy(true); setError('');
    try {
      await api('/api/hikvision/links/' + link.id, { method: 'DELETE', body: JSON.stringify({ reason: 'Removed from device mapping.' }) });
      setNote('Mapping removed.');
      await loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally { setBusy(false); }
  };

  const runSync = async (kind: 'one' | 'bulk' | 'fleet', employeeId?: number, deviceIdRaw?: string) => {
    const scope = kind === 'bulk' ? 'hikvision.sync.bulk' : 'hikvision.sync.employee';
    if (!can(user, scope)) { setError('You do not have permission to synchronize employees.'); return; }
    setBusy(true); setError(''); setFormErr(''); setResult(null);
    try {
      let r: Rec;
      if (kind === 'one') {
        r = await api<{ data: Rec }>('/api/hikvision/sync/employee', {
          method: 'POST',
          body: JSON.stringify({ employeeId, deviceId: deviceIdRaw ? Number(deviceIdRaw) : undefined, reason: 'Operator sync.' }),
        });
      } else if (kind === 'fleet') {
        const ids = links.filter((l) => l.employeeId).map((l) => Number(l.employeeId)).filter((n, i, a) => a.indexOf(n) === i).slice(0, 200);
        r = await api<{ data: Rec }>('/api/hikvision/sync/selected', {
          method: 'POST',
          body: JSON.stringify({ employeeIds: ids, deviceId: bulkDevice ? Number(bulkDevice) : undefined, limit: 200 }),
        });
      } else {
        r = await api<{ data: Rec }>('/api/hikvision/sync/bulk', {
          method: 'POST',
          body: JSON.stringify({ deviceId: bulkDevice ? Number(bulkDevice) : undefined, limit: Number(bulkLimit) || 200 }),
        });
      }
      setResult((r.data ?? null) as Rec | null);
      setNote('Synchronization completed.');
      await loadLinks();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : 'Synchronization failed');
    } finally { setBusy(false); }
  };

  const runEmployeeAction = async (employeeId: number, action: 'deactivate' | 'disable' | 'remove-access', deviceIdRaw?: string) => {
    if (!canRemove && action !== 'deactivate') { setError('You do not have permission to disable device access.'); return; }
    const msg = action === 'deactivate'
      ? 'Deactivate this employee on every terminal and move mappings to INACTIVE?'
      : action === 'disable'
        ? 'Disable access for this employee?'
        : 'Remove all device access for this employee?';
    if (!window.confirm(msg)) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/sync/employees/' + employeeId + '/' + action, {
        method: 'POST',
        body: JSON.stringify({ deviceId: deviceIdRaw ? Number(deviceIdRaw) : undefined, reason: 'Operator request.' }),
      });
      setResult(r.data);
      setNote('Action completed and logged.');
      await loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally { setBusy(false); }
  };

  const summary = (r: Rec | null) => (r && typeof r.summary === 'object' ? (r.summary as Rec) : null);

  if (error && links.length === 0 && logs.length === 0) return <ErrorBanner error={error} />;

  return (
    <div className="page">
      <HikHead
        title="Employee Synchronization"
        subtitle="Map ERP employees to Hikvision terminals, provision devices and review sync logs."
        actions={
          canCreateLink ? (
            <div className="head-actions">
              <button type="button" className="btn btn-sm" onClick={openCreate}>New employee mapping</button>
            </div>
          ) : undefined
        }
      />
      <HikTabs active="sync" />
      {error ? <ErrorBanner error={error} /> : null}
      {note ? <Saved msg={note} /> : null}
      {formErr ? <FormErr msg={formErr} /> : null}

      <div className="hk-tabs" role="tablist" aria-label="Synchronization views">
        <button type="button" className={'tab' + (tab === 'links' ? ' active' : '')} onClick={() => setTab('links')}>Employee mappings</button>
        <button type="button" className={'tab' + (tab === 'logs' ? ' active' : '')} onClick={() => setTab('logs')}>Sync logs</button>
        {canBulk ? (
          <button type="button" className={'tab' + (tab === 'provision' ? ' active' : '')} onClick={() => setTab('provision')}>Provision terminals</button>
        ) : null}
      </div>

      {tab === 'links' ? (
        <>
          <section className="card card-pad">
            <div className="card-head">
              <h3>Employee ↔ terminal mappings</h3>
              <div className="head-actions" style={{ flexWrap: 'wrap' }}>
                <select className="hk-select" value={linkStatus} onChange={(e) => { setLinkStatus(e.target.value); setPage(1); }}>
                  <option value="">All statuses</option>
                  {LINK_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input className="hk-input" style={{ width: 240 }} placeholder="Search employee / device / identifier..." value={linkQ}
                  onChange={(e) => { setLinkQ(e.target.value); setPage(1); }} />
                <button type="button" className="btn btn-sm" onClick={() => void loadLinks()}>Refresh</button>
              </div>
            </div>
            {links.length === 0 ? (
              <div className="empty-state"><h3>No mappings</h3><p>Map employees to terminals so their employee numbers are recognised.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Employee</th><th>Terminal</th><th>Device identifier</th><th>Verification</th><th>Status</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {links.map((l) => {
                      const emp = (l.employee ?? null) as Rec | null;
                      const dev = (l.device ?? null) as Rec | null;
                      const canAct = canSync || canRemove || canUpdateLink;
                      return (
                        <tr key={l.id}>
                          <td>
                            <div className="emp-cell">
                              {emp ? <MiniAvatar name={empName(emp)} /> : null}
                              <div>
                                <strong>{emp ? empName(emp) : 'Unknown'}</strong>
                                <span className="muted">{emp ? empNo(emp) : toStr(l.employeeId)}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            {dev ? (
                              <div><strong>{pickS(dev, 'name')}</strong><span className="muted">{pickS(dev, 'code')} · {pickS(dev, 'serialNumber')}</span></div>
                            ) : <span className="muted">All devices</span>}
                          </td>
                          <td><code style={{ fontSize: 12 }}>{toStr(l.employeeIdentifier)}</code></td>
                          <td>{VERIF_LABEL[toStr(l.verificationMethod).toUpperCase()] ?? toStr(l.verificationMethod)}</td>
                          <td>{linkPill(l.status)}</td>
                          <td>
                            <div className="hk-inline">
                              {canSync ? (
                                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runSync('one', Number(l.employeeId), l.deviceId ? String(l.deviceId) : '')}>Sync</button>
                              ) : null}
                              {canUpdateLink ? (
                                <select className="hk-select" value={toStr(l.status)} aria-label="Change link status" onChange={(e) => void setLinkStatusRow(l, e.target.value)}>
                                  {LINK_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              ) : null}
                              {canRemove ? (
                                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void runEmployeeAction(Number(l.employeeId), 'remove-access', l.deviceId ? String(l.deviceId) : '')}>Remove access</button>
                              ) : null}
                              {canDeleteLink ? (
                                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void deleteLink(l)}>Delete</button>
                              ) : null}
                            </div>
                            {!canAct ? <span className="muted">Read only</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
          </section>

          {result ? (
            <Modal title="Synchronization result" onClose={() => setResult(null)} wide
              footer={<div className="hk-actions" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-sm" onClick={() => setResult(null)}>Close</button></div>}>
              <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                {(['success', 'skipped', 'failed', 'total'] as const).map((k) => (
                  <div key={k} className="card card-pad"><span className="kpi-label">{k}</span><span className="kpi-value">{pickN(summary(result), k)}</span></div>
                ))}
              </div>
              <p className="hk-note" style={{ marginTop: 10 }}>Every provisioning attempt is recorded in the sync log and the audit trail.</p>
            </Modal>
          ) : null}

          {createOpen ? (
            <Modal title="Map employee to Hikvision terminal" onClose={() => setCreateOpen(false)} wide
              footer={
                <div className="hk-actions" style={{ justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-sm" onClick={() => setCreateOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || !mkEmployeeId || !mkIdentifier.trim()} onClick={() => void createLink()}>Save mapping</button>
                </div>
              }>
              <div className="hk-card-grid">
                <Field label="Employee" req>
                  <input className="hk-input" placeholder="Search employee number or name..." value={empQ} onChange={(e) => void searchEmployees(e.target.value)} />
                  {empBusy ? <span className="hk-subnote">Searching...</span> : null}
                  {empRows.length > 0 ? (
                    <ul className="hk-options">
                      {empRows.map((row) => (
                        <li key={toStr(pickN(row, 'id'))}>
                          <button type="button" className={'hk-option' + (mkEmployeeId === toStr(pickN(row, 'id')) ? ' selected' : '')} onClick={() => pickEmployee(row)}>
                            <strong>{empName(row)}</strong>
                            <span className="muted">{empNo(row) || 'no employee number'}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Field>
                <Field label="Terminal" hint="Leave empty to apply the identifier on every terminal.">
                  <Sel value={mkDeviceId} onChange={setMkDeviceId} options={devices.map((d) => ({ value: toStr(pickN(d, 'id')), label: pickS(d, 'name') + ' · ' + pickS(d, 'serialNumber') }))} placeholder="All devices (no specific terminal)" />
                </Field>
                <Field label="Device employee number" req hint="The employeeNoString the terminal reports.">
                  <Inp value={mkIdentifier} onChange={setMkIdentifier} placeholder="e.g. HDG-EMP-2026-000125" />
                </Field>
                <Field label="Verification method">
                  <Sel value={mkMethod} onChange={setMkMethod} options={VERIFY_OPTIONS} />
                </Field>
                <Field label="Mapping status">
                  <Sel value={mkStatus} onChange={setMkStatus} options={LINK_STATUS_OPTIONS} />
                </Field>
                <Field label="Notes">
                  <Txa value={mkNotes} onChange={setMkNotes} />
                </Field>
              </div>
            </Modal>
          ) : null}
        </>
      ) : null}

      {tab === 'logs' ? (
        <section className="card card-pad">
          <div className="card-head">
            <h3>Sync journal</h3>
            <div className="head-actions" style={{ flexWrap: 'wrap' }}>
              <select className="hk-select" value={logsAction} onChange={(e) => { setLogsAction(e.target.value); setLogsPage(1); }}>
                <option value="">All actions</option>
                {ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select className="hk-select" value={logsStatus} onChange={(e) => { setLogsStatus(e.target.value); setLogsPage(1); }}>
                <option value="">All outcomes</option>
                {SYNC_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select className="hk-select" value={logsDevice} onChange={(e) => { setLogsDevice(e.target.value); setLogsPage(1); }}>
                <option value="">All terminals</option>
                {devices.map((d) => <option key={toStr(pickN(d, 'id'))} value={toStr(pickN(d, 'id'))}>{pickS(d, 'name')}</option>)}
              </select>
              <input className="hk-input" style={{ width: 140 }} placeholder="Employee ID..." value={logsQ} onChange={(e) => { setLogsQ(e.target.value); setLogsPage(1); }} />
              <button type="button" className="btn btn-sm" onClick={() => void loadLogs()}>Refresh</button>
            </div>
          </div>
          {logs.length === 0 ? (
            <div className="empty-state"><h3>No sync activity</h3><p>Provisioning actions will appear here.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Action</th><th>Outcome</th><th>Employee</th><th>Terminal</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {logs.map((row) => {
                    const emp = (row.employee ?? null) as Rec | null;
                    const dev = (row.device ?? null) as Rec | null;
                    return (
                      <tr key={toStr(row.id)}>
                        <td><span className="muted">{fmtWhen(row.createdAt)}</span></td>
                        <td>{ACTION_LABEL[toStr(row.action)] ?? toStr(row.action)}</td>
                        <td>{statusPill(row.status, SYNC_TONE, { SUCCESS: 'Success', PARTIAL: 'Partial', FAILED: 'Failed', SKIPPED: 'Skipped' })}</td>
                        <td>{emp ? empName(emp) + (empNo(emp) ? ' · ' + empNo(emp) : '') : <span className="muted">Fleet</span>}</td>
                        <td>{dev ? pickS(dev, 'name') : <span className="muted">All terminals</span>}</td>
                        <td style={{ maxWidth: 380 }}>
                          {toStr(row.errorMessage) ? <span className="badge badge-red">{toStr(row.errorMessage)}</span> : null}
                          {!toStr(row.errorMessage) && row.requestPayload ? <span className="muted">{toStr(row.requestPayload).slice(0, 120)}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={logsPage} pageSize={25} total={logsTotal} onPage={setLogsPage} />
        </section>
      ) : null}

      {tab === 'provision' && canBulk ? (
        <div className="hk-board-grid">
          <section className="card card-pad">
            <div className="card-head"><h3>Bulk synchronize active workforce</h3><span className="muted">ACTIVE employees in your scope</span></div>
            <div className="hk-card-grid">
              <Field label="Target terminal" hint="Leave empty to target every registered terminal.">
                <Sel value={bulkDevice} onChange={setBulkDevice} options={devices.map((d) => ({ value: toStr(pickN(d, 'id')), label: pickS(d, 'name') }))} placeholder="All terminals (fleet)" />
              </Field>
              <Field label="Batch limit" hint="Maximum employees per run (server caps at 500).">
                <Inp value={bulkLimit} onChange={setBulkLimit} inputMode="numeric" />
              </Field>
            </div>
            <div className="hk-actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => void runSync('bulk')}>
                {busy ? 'Synchronizing...' : 'Bulk sync active employees'}
              </button>
              <p className="hk-note" style={{ margin: 0 }}>
                <strong>Employee deactivation removes the card from every terminal.</strong>
                ERP stays the source of truth; remote commands are best effort and logged.
              </p>
            </div>
          </section>
          <section className="card card-pad">
            <div className="card-head"><h3>How provisioning works</h3></div>
            <ul className="prose" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Every employee must be mapped to a device before the terminal recognises their number.</li>
              <li>Biometric templates stay on the terminal — the ERP never receives them.</li>
              <li>Sync sends identity + card details only (employee number, name, department, card number).</li>
              <li>Deactivation moves mappings to INACTIVE immediately and issues a remote disable when supported.</li>
              <li>Each action is journaled in the sync log and the audit trail.</li>
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
