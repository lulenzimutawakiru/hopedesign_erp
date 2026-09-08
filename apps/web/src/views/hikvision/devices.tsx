import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Modal, Pager, PageLoader, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS, pickB,
  PURPOSE_LABEL, DEVICE_STATUS_LABEL, DEVICE_STATUS_TONE, SEVERITY_TONE, RAW_STATUS_TONE,
  statusPill, purposePill, fmtWhen, MiniAvatar,
} from './shared';
import { Field, Inp, Sel, Check, Txa, FormErr, Saved } from './fields';
import { qs } from './hkutil';

const STATUSES = ['ONLINE', 'OFFLINE', 'WARNING', 'MAINTENANCE', 'DISABLED'];
const PURPOSES = Object.keys(PURPOSE_LABEL);

interface DevForm {
  companyId: string; code: string; name: string; model: string; serialNumber: string;
  ipAddress: string; macAddress: string; facility: string; physicalLocation: string;
  devicePurpose: string; timezone: string; firmwareVersion: string;
  branchId: string; departmentId: string;
  isapiEnabled: boolean; isapiUsername: string; isapiPassword: string; allowQueryKey: boolean;
  ipAllowlist: string;
  attendanceEnabled: boolean; accessEventsEnabled: boolean;
  duplicateWindowSeconds: string; replayWindowSeconds: string;
  allowFutureMinutes: string; allowPastMinutes: string;
  breakStart: string; breakEnd: string; defaultShiftCode: string;
  notifyDeviceOffline: boolean; notifyDeviceOnline: boolean; notifyClockDrift: boolean;
  notifyUnknownEmployee: boolean; notifyIntegrationFailure: boolean;
  clockDriftWarningSeconds: string; heartbeatStaleSeconds: string; heartbeatIntervalSeconds: string;
}

const EMPTY: DevForm = {
  companyId: '', code: '', name: '', model: '', serialNumber: '',
  ipAddress: '', macAddress: '', facility: '', physicalLocation: '',
  devicePurpose: 'ATTENDANCE', timezone: 'Africa/Kampala', firmwareVersion: '',
  branchId: '', departmentId: '',
  isapiEnabled: false, isapiUsername: '', isapiPassword: '', allowQueryKey: false,
  ipAllowlist: '',
  attendanceEnabled: true, accessEventsEnabled: true,
  duplicateWindowSeconds: '30', replayWindowSeconds: '60',
  allowFutureMinutes: '5', allowPastMinutes: '1440',
  breakStart: '12:30', breakEnd: '13:30', defaultShiftCode: '',
  notifyDeviceOffline: true, notifyDeviceOnline: true, notifyClockDrift: true,
  notifyUnknownEmployee: true, notifyIntegrationFailure: true,
  clockDriftWarningSeconds: '180', heartbeatStaleSeconds: '300', heartbeatIntervalSeconds: '300',
};

const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: DEVICE_STATUS_LABEL[s] }));
const PURPOSE_OPTIONS = PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p] }));
function formFromDevice(dev: Rec, cfg: Rec | null): DevForm {
  const config = cfg ?? {};
  const f: DevForm = { ...EMPTY };
  f.companyId = pickS(dev, 'company_id');
  f.code = pickS(dev, 'code');
  f.name = pickS(dev, 'name');
  f.model = pickS(dev, 'model');
  f.serialNumber = pickS(dev, 'serial_number');
  f.ipAddress = pickS(dev, 'ip_address');
  f.macAddress = pickS(dev, 'mac_address');
  f.facility = pickS(dev, 'facility');
  f.physicalLocation = pickS(dev, 'physical_location');
  f.devicePurpose = pickS(dev, 'device_purpose', 'ATTENDANCE');
  f.timezone = pickS(dev, 'timezone', 'Africa/Kampala');
  f.firmwareVersion = pickS(dev, 'firmware_version');
  f.branchId = pickS(dev, 'branch_id');
  f.departmentId = pickS(dev, 'department_id');
  f.isapiEnabled = pickB(dev, 'isapi_enabled');
  f.isapiUsername = pickS(dev, 'isapi_username');
  f.allowQueryKey = pickB(dev, 'allow_query_key');
  const allowlist = dev['ip_allowlist'];
  f.ipAllowlist = Array.isArray(allowlist) ? allowlist.join('\n') : pickS(dev, 'ip_allowlist');
  f.attendanceEnabled = pickB(config, 'attendance_enabled', true);
  f.accessEventsEnabled = pickB(config, 'access_events_enabled', true);
  f.duplicateWindowSeconds = pickS(config, 'duplicate_window_seconds', '30');
  f.replayWindowSeconds = pickS(config, 'replay_window_seconds', '60');
  f.allowFutureMinutes = pickS(config, 'allow_future_minutes', '5');
  f.allowPastMinutes = pickS(config, 'allow_past_minutes', '1440');
  f.breakStart = pickS(config, 'break_start', '12:30');
  f.breakEnd = pickS(config, 'break_end', '13:30');
  f.defaultShiftCode = pickS(config, 'default_shift_code');
  f.notifyDeviceOffline = pickB(config, 'notify_device_offline', true);
  f.notifyDeviceOnline = pickB(config, 'notify_device_online', true);
  f.notifyClockDrift = pickB(config, 'notify_clock_drift', true);
  f.notifyUnknownEmployee = pickB(config, 'notify_unknown_employee', true);
  f.notifyIntegrationFailure = pickB(config, 'notify_integration_failure', true);
  f.clockDriftWarningSeconds = pickS(config, 'clock_drift_warning_seconds', '180');
  f.heartbeatStaleSeconds = pickS(config, 'heartbeat_stale_seconds', '300');
  f.heartbeatIntervalSeconds = pickS(config, 'heartbeat_interval_seconds', '300');
  return f;
}

function splitList(v: string): string[] {
  return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function buildPayload(f: DevForm, isEdit: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {
    code: f.code.trim() || undefined,
    name: f.name.trim(),
    model: f.model.trim() || undefined,
    serialNumber: f.serialNumber.trim(),
    ipAddress: f.ipAddress.trim() || undefined,
    macAddress: f.macAddress.trim() || undefined,
    facility: f.facility.trim() || undefined,
    physicalLocation: f.physicalLocation.trim() || undefined,
    devicePurpose: f.devicePurpose,
    timezone: f.timezone.trim() || 'UTC',
    firmwareVersion: f.firmwareVersion.trim() || undefined,
    isapiEnabled: f.isapiEnabled,
    isapiUsername: f.isapiUsername.trim() || undefined,
    allowQueryKey: f.allowQueryKey,
    ipAllowlist: splitList(f.ipAllowlist),
    branchId: f.branchId ? Number(f.branchId) : undefined,
    departmentId: f.departmentId ? Number(f.departmentId) : undefined,
    attendanceEnabled: f.attendanceEnabled,
    accessEventsEnabled: f.accessEventsEnabled,
    duplicateWindowSeconds: Number(f.duplicateWindowSeconds || 30),
    replayWindowSeconds: Number(f.replayWindowSeconds || 60),
    allowFutureMinutes: Number(f.allowFutureMinutes || 5),
    allowPastMinutes: Number(f.allowPastMinutes || 1440),
    breakStart: f.breakStart.trim() || null,
    breakEnd: f.breakEnd.trim() || null,
    defaultShiftCode: f.defaultShiftCode.trim() || null,
    notifyDeviceOffline: f.notifyDeviceOffline,
    notifyDeviceOnline: f.notifyDeviceOnline,
    notifyClockDrift: f.notifyClockDrift,
    notifyUnknownEmployee: f.notifyUnknownEmployee,
    notifyIntegrationFailure: f.notifyIntegrationFailure,
    clockDriftWarningSeconds: Number(f.clockDriftWarningSeconds || 180),
    heartbeatStaleSeconds: Number(f.heartbeatStaleSeconds || 300),
    heartbeatIntervalSeconds: Number(f.heartbeatIntervalSeconds || 300),
  };
  if (!isEdit) p.companyId = Number(f.companyId);
  if (f.isapiPassword.trim()) p.isapiPassword = f.isapiPassword;
  return p;
}

function DeviceForm({ mode, device, configuration, onClose, onSaved, userCompanyId }: {
  mode: 'create' | 'edit'; device: Rec | null; configuration: Rec | null;
  onClose: () => void; onSaved: () => void; userCompanyId: number | null;
}) {
  const isEdit = mode === 'edit';
  const [f, setF] = useState<DevForm>(() =>
    device ? formFromDevice(device, configuration) : { ...EMPTY, companyId: userCompanyId ? String(userCompanyId) : '' }
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [keyText, setKeyText] = useState('');
  function setField<K extends keyof DevForm>(k: K, v: DevForm[K]): void {
    setF((prev) => ({ ...prev, [k]: v }));
  }

  const save = async () => {
    if (!f.name.trim()) { setErr('Device name is required.'); return; }
    if (!f.serialNumber.trim()) { setErr('Serial number is required.'); return; }
    if (!isEdit && !f.companyId.trim()) { setErr('Company ID is required. Pre-filled from your session when you belong to one company.'); return; }
    if (f.ipAddress.trim() && !/^\d{1,3}(\.\d{1,3}){3}$/.test(f.ipAddress.trim())) { setErr('IP address must be a valid IPv4 address.'); return; }
    setErr(''); setSaved(''); setBusy(true);
    try {
      const body = buildPayload(f, isEdit);
      const path = isEdit ? '/api/hikvision/devices/' + pickS(device, 'id') : '/api/hikvision/devices';
      const r = await api<{ data: Rec }>(path, { method: isEdit ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      if (!isEdit) setKeyText(toStr(r.data.deviceKey));
      setSaved(toStr(r.data.message) || 'Device saved.');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={isEdit ? 'Edit device' : 'Register Hikvision device'} onClose={onClose} wide>
      <FormErr msg={err} />
      {saved ? <Saved msg={saved} /> : null}
      {keyText ? (
        <div className="notice-banner" style={{ marginBottom: 10 }}>
          <strong>One-time device key</strong>
          <p className="hk-note" style={{ margin: '6px 0' }}>
            Configure this key on the terminal webhook (X-Hik-Key header / key query parameter). It is shown only once.
          </p>
          <textarea className="hk-input" readOnly rows={2} value={keyText} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
        </div>
      ) : null}
      <div className="hk-card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
        <Field label="Company ID" req>
          <Inp value={f.companyId} onChange={(v) => setField('companyId', v)} disabled={isEdit} inputMode="numeric" placeholder="e.g. 1" />
        </Field>
        <Field label="Device name" req>
          <Inp value={f.name} onChange={(v) => setField('name', v)} placeholder="Main Gate Terminal" />
        </Field>
        <Field label="Serial number" req>
          <Inp value={f.serialNumber} onChange={(v) => setField('serialNumber', v)} disabled={isEdit} placeholder="DSK1T-XXXXXXXX" />
        </Field>
        <Field label="Device code">
          <Inp value={f.code} onChange={(v) => setField('code', v)} placeholder="Auto-generated when blank" />
        </Field>
        <Field label="Model">
          <Inp value={f.model} onChange={(v) => setField('model', v)} placeholder="DS-K1T671" />
        </Field>
        <Field label="IP address">
          <Inp value={f.ipAddress} onChange={(v) => setField('ipAddress', v)} placeholder="10.0.0.10" />
        </Field>
        <Field label="MAC address">
          <Inp value={f.macAddress} onChange={(v) => setField('macAddress', v)} placeholder="AA:BB:CC:DD:EE:FF" />
        </Field>
        <Field label="Purpose" req>
          <Sel value={f.devicePurpose} onChange={(v) => setField('devicePurpose', v)} options={PURPOSE_OPTIONS} />
        </Field>
        <Field label="Timezone">
          <Inp value={f.timezone} onChange={(v) => setField('timezone', v)} placeholder="Africa/Kampala" />
        </Field>
        <Field label="Firmware version">
          <Inp value={f.firmwareVersion} onChange={(v) => setField('firmwareVersion', v)} placeholder="V1.4.72" />
        </Field>
        <Field label="Branch ID">
          <Inp value={f.branchId} onChange={(v) => setField('branchId', v)} inputMode="numeric" placeholder="Branch within the company" />
        </Field>
        <Field label="Department ID">
          <Inp value={f.departmentId} onChange={(v) => setField('departmentId', v)} inputMode="numeric" placeholder="Department within the company" />
        </Field>
        <Field label="Facility">
          <Inp value={f.facility} onChange={(v) => setField('facility', v)} placeholder="Factory / Head Office" />
        </Field>
        <Field label="Physical location">
          <Inp value={f.physicalLocation} onChange={(v) => setField('physicalLocation', v)} placeholder="Main entrance" />
        </Field>
      </div>
      <hr className="hk-divider" />
      <div className="section-title">Terminal provisioning</div>
      <div className="hk-card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
        <Field label="ISAPI username">
          <Inp value={f.isapiUsername} onChange={(v) => setField('isapiUsername', v)} placeholder="admin" />
        </Field>
        <Field label="ISAPI password">
          <Inp value={f.isapiPassword} onChange={(v) => setField('isapiPassword', v)} type="password" placeholder={isEdit ? 'Leave blank to keep current' : 'admin password'} />
        </Field>
        <div className="hk-stack" style={{ gap: 6, paddingTop: 18 }}>
          <Check label="Enable ISAPI remote provisioning" checked={f.isapiEnabled} onChange={(v) => setField('isapiEnabled', v)} />
          <Check label="Accept query-key authentication" checked={f.allowQueryKey} onChange={(v) => setField('allowQueryKey', v)} />
        </div>
      </div>
      <Field label="IP allowlist (one IP or CIDR per line)">
        <Txa value={f.ipAllowlist} onChange={(v) => setField('ipAllowlist', v)} placeholder={'10.0.0.0/8\n192.168.1.0/24'} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
      </Field>
      <hr className="hk-divider" />
      <div className="section-title">Processing configuration</div>
      <div className="hk-card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))' }}>
        <Field label="Duplicate window (sec)">
          <Inp value={f.duplicateWindowSeconds} onChange={(v) => setField('duplicateWindowSeconds', v)} inputMode="numeric" />
        </Field>
        <Field label="Replay window (sec)">
          <Inp value={f.replayWindowSeconds} onChange={(v) => setField('replayWindowSeconds', v)} inputMode="numeric" />
        </Field>
        <Field label="Allow future (min)">
          <Inp value={f.allowFutureMinutes} onChange={(v) => setField('allowFutureMinutes', v)} inputMode="numeric" />
        </Field>
        <Field label="Allow past (min)">
          <Inp value={f.allowPastMinutes} onChange={(v) => setField('allowPastMinutes', v)} inputMode="numeric" />
        </Field>
        <Field label="Break start">
          <Inp value={f.breakStart} onChange={(v) => setField('breakStart', v)} placeholder="12:30" />
        </Field>
        <Field label="Break end">
          <Inp value={f.breakEnd} onChange={(v) => setField('breakEnd', v)} placeholder="13:30" />
        </Field>
        <Field label="Default shift code">
          <Inp value={f.defaultShiftCode} onChange={(v) => setField('defaultShiftCode', v)} placeholder="GENERAL" />
        </Field>
        <Field label="Clock drift warning (sec)">
          <Inp value={f.clockDriftWarningSeconds} onChange={(v) => setField('clockDriftWarningSeconds', v)} inputMode="numeric" />
        </Field>
        <Field label="Heartbeat stale (sec)">
          <Inp value={f.heartbeatStaleSeconds} onChange={(v) => setField('heartbeatStaleSeconds', v)} inputMode="numeric" />
        </Field>
        <Field label="Heartbeat interval (sec)">
          <Inp value={f.heartbeatIntervalSeconds} onChange={(v) => setField('heartbeatIntervalSeconds', v)} inputMode="numeric" />
        </Field>
      </div>
      <div className="hk-stack" style={{ gap: 6, marginTop: 10 }}>
        <div className="hk-inline">
          <Check label="Attendance events" checked={f.attendanceEnabled} onChange={(v) => setField('attendanceEnabled', v)} />
          <Check label="Access events" checked={f.accessEventsEnabled} onChange={(v) => setField('accessEventsEnabled', v)} />
        </div>
        <div className="hk-inline">
          <Check label="Notify device offline" checked={f.notifyDeviceOffline} onChange={(v) => setField('notifyDeviceOffline', v)} />
          <Check label="Notify device online" checked={f.notifyDeviceOnline} onChange={(v) => setField('notifyDeviceOnline', v)} />
          <Check label="Notify clock drift" checked={f.notifyClockDrift} onChange={(v) => setField('notifyClockDrift', v)} />
          <Check label="Notify unknown employee" checked={f.notifyUnknownEmployee} onChange={(v) => setField('notifyUnknownEmployee', v)} />
          <Check label="Notify integration failure" checked={f.notifyIntegrationFailure} onChange={(v) => setField('notifyIntegrationFailure', v)} />
        </div>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving...' : isEdit ? 'Save changes' : 'Register device'}
        </button>
      </div>
    </Modal>
  );
}
function DriftText({ sec }: { sec: unknown }) {
  if (sec === null || sec === undefined || sec === '') return <span className="muted">-</span>;
  const s = toNum(sec);
  if (s === 0) return <span className="hk-drift-good">In sync</span>;
  const abs = Math.abs(s);
  const label = abs < 60 ? abs + 's' : Math.floor(abs / 60) + 'm ' + (abs % 60) + 's';
  const cls = abs >= 600 ? 'hk-drift-bad' : abs >= 180 ? 'hk-drift-warn' : 'hk-drift-good';
  return <span className={cls}>{s > 0 ? '+' : '-'}{label}</span>;
}

export default function DevicesView() {
  const { user } = useAuth();
  const canUpdate = can(user, 'hikvision.devices.update');
  const canCreate = can(user, 'hikvision.devices.create');
  const canDelete = can(user, 'hikvision.devices.delete');
  const canManage = can(user, 'hikvision.configuration.manage');

  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [purpose, setPurpose] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [reloadTick, setReloadTick] = useState(0);

  const [detail, setDetail] = useState<Rec | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [formDevice, setFormDevice] = useState<Rec | null>(null);
  const [formCfg, setFormCfg] = useState<Rec | null>(null);
  const [syncNote, setSyncNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<Rec | null>(null);
  const [delReason, setDelReason] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    try {
      const query = qs({ status, purpose, q: q.trim() || undefined, page, pageSize });
      const r = await api<{ data: Rec }>('/api/hikvision/devices' + query);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Devices failed to load');
    }
  }, [status, purpose, q, page, pageSize]);

  useEffect(() => { void load(); }, [load, reloadTick]);

  const openDetail = useCallback(async (id: number) => {
    setSyncNote(''); setBusyId(id);
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/devices/' + id);
      setDetail(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Device detail failed');
    } finally {
      setBusyId(null);
    }
  }, []);

  const reloadAll = useCallback(() => {
    setReloadTick((t) => t + 1);
    const id = detail ? toNum(pickS(detail.device as Rec | null, 'id')) : 0;
    if (id > 0) void openDetail(id);
  }, [detail, openDetail]);

  const act = useCallback(async (method: string, path: string, body?: Record<string, unknown>) => {
    const r = await api<{ data: Rec }>(path, { method, body: body ? JSON.stringify(body) : undefined });
    return r.data;
  }, []);

  const changeStatus = async (dev: Rec, next: string) => {
    let reason = '';
    if (next === 'MAINTENANCE' || next === 'DISABLED') {
      const raw = window.prompt('Reason for ' + next + '? (recorded in the audit trail)');
      if (raw === null) return;
      reason = raw;
    }
    try {
      await act('POST', '/api/hikvision/devices/' + pickS(dev, 'id') + '/status', { status: next, reason: reason || undefined });
      setToast('Device marked ' + DEVICE_STATUS_LABEL[next] + '.');
      setSyncNote('');
      reloadAll();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Status change failed');
    }
  };

  const doRotate = async (dev: Rec) => {
    try {
      const r = await act('POST', '/api/hikvision/devices/' + pickS(dev, 'id') + '/rotate-key', {});
      setSyncNote(JSON.stringify({ message: r.message, deviceKey: r.deviceKey }, null, 2));
      reloadAll();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Key rotation failed');
    }
  };

  const doTimeSync = async (dev: Rec, remote: boolean) => {
    try {
      const r = await act('POST', '/api/hikvision/devices/' + pickS(dev, 'id') + '/time-sync', { syncRemote: remote });
      setSyncNote(JSON.stringify(r, null, 2));
      reloadAll();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Time sync failed');
    }
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/devices/' + pickS(confirmDel, 'id'), {
        method: 'DELETE',
        body: JSON.stringify({ reason: delReason.trim() || undefined }),
      });
      setToast(toStr(r.data.message) || 'Device deleted or disabled.');
      setConfirmDel(null); setDelReason(''); setDetail(null); reloadAll();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Delete failed');
    }
  };
  const items = ((data ?? {}).items ?? []) as Rec[];
  const total = toNum((data ?? {}).total);
  const rows = (detail?.device ?? null) as Rec | null;
  const cfg = ((detail?.configuration ?? {}) as Rec) ?? {};
  const stats = (detail?.stats ?? {}) as Rec;
  const dev = rows;

  return (
    <div className="page">
      <HikHead
        title="Hikvision Devices"
        subtitle="Face recognition and access-control terminals registered to HOPE DESIGN ERP."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { setFormMode('create'); setFormDevice(null); setFormCfg(null); }}>
              Register device
            </button>
          ) : undefined
        }
      />
      <HikTabs active="devices" />
      {toast ? (
        <div className="notice-banner" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{toast}</span>
          <button type="button" className="modal-close" onClick={() => setToast('')} aria-label="Dismiss">{'\u2715'}</button>
        </div>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}

      <div className="hk-toolbar">
        <Field label="Status">
          <Sel value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} placeholder="All statuses" />
        </Field>
        <Field label="Purpose">
          <Sel value={purpose} onChange={(v) => { setPurpose(v); setPage(1); }} options={PURPOSE_OPTIONS} placeholder="All purposes" />
        </Field>
        <div className="hk-search">
          <span className="hk-lbl">Search</span>
          <input className="hk-input" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); void load(); } }}
            placeholder="Name, code, serial or IP" />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => { setPage(1); void load(); }}>Apply</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setStatus(''); setPurpose(''); setQ(''); setPage(1); }}>Reset</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{total} device{total === 1 ? '' : 's'}</span>
      </div>

      {!data ? (
        <PageLoader label="Loading devices..." />
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>No devices registered</h3>
          <p>Register your first Hikvision terminal to start receiving biometric and card events.</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Purpose</th>
                  <th>Location</th>
                  <th>Branch / Department</th>
                  <th>IP address</th>
                  <th>Status</th>
                  <th>Clock drift</th>
                  <th>Last heartbeat</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => {
                  const id = pickS(d, 'id');
                  return (
                    <tr key={id}>
                      <td>
                        <div className="hk-avatar-row">
                          <MiniAvatar name={pickS(d, 'name')} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{pickS(d, 'name')}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>{pickS(d, 'code')} {'\u2022'} {pickS(d, 'model') || 'Hikvision'}</div>
                          </div>
                        </div>
                      </td>
                      <td>{purposePill(pickS(d, 'device_purpose'))}</td>
                      <td>
                        <div>{pickS(d, 'facility')}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{pickS(d, 'physical_location')}</div>
                      </td>
                      <td>
                        <div>{pickS(d, 'branch_name')}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{pickS(d, 'department_name')}</div>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {pickS(d, 'ip_address') || '-'}
                      </td>
                      <td>{statusPill(pickS(d, 'connection_status'), DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL)}</td>
                      <td><DriftText sec={pickS(d, 'last_clock_drift_seconds')} /></td>
                      <td><span className="muted">{fmtWhen(pickS(d, 'last_heartbeat_at'))}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn-sm" disabled={busyId === Number(id)}
                          onClick={() => void openDetail(Number(id))}>
                          {busyId === Number(id) ? 'Loading...' : 'Manage'}
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
      {detail && dev ? (
        <Modal
          title={'Manage ' + pickS(dev, 'name')}
          onClose={() => setDetail(null)}
          wide
          footer={
            <div className="hk-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm" onClick={() => setDetail(null)}>Close</button>
              {canUpdate ? (
                <button type="button" className="btn btn-sm" onClick={() => { setFormMode('edit'); setFormDevice(dev); setFormCfg(cfg); }}>
                  Edit device
                </button>
              ) : null}
              {canUpdate ? (
                <button type="button" className="btn btn-sm" onClick={() => void doRotate(dev)}>Rotate webhook key</button>
              ) : null}
              {canManage ? (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => void doTimeSync(dev, false)}>Record server time</button>
                  <button type="button" className="btn btn-sm" onClick={() => void doTimeSync(dev, true)}>Sync device clock (ISAPI)</button>
                </>
              ) : null}
              {canDelete ? (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => { setConfirmDel(dev); setDelReason(''); }}>
                  Delete
                </button>
              ) : null}
            </div>
          }
        >
          <div className="hk-summary-strip">
            {(['processed_24h', 'duplicates_24h', 'failed_24h', 'rejected_24h', 'events_24h'] as const).map((k) => (
              <div className="card card-pad" key={k} style={{ padding: '10px 14px' }}>
                <div className="kpi-label">{k.replace(/_24h$/, '').replace(/_/g, ' ')}</div>
                <div className="kpi-value">{toNum(pickS(stats, k))}</div>
              </div>
            ))}
          </div>
          {syncNote ? (
            <div className="hk-warn-bar" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>Operation result</strong>
                <button type="button" className="modal-close" onClick={() => setSyncNote('')} aria-label="Clear">{'\u2715'}</button>
              </div>
              <pre className="json-pre" style={{ maxHeight: 180 }}>{syncNote}</pre>
            </div>
          ) : null}
          <div className="section-title">Identity and location</div>
          <div className="kv-grid">
            <div className="kv"><span className="kv-k">Serial number</span><span className="kv-v">{pickS(dev, 'serial_number')}</span></div>
            <div className="kv"><span className="kv-k">Code</span><span className="kv-v">{pickS(dev, 'code')}</span></div>
            <div className="kv"><span className="kv-k">Model</span><span className="kv-v">{pickS(dev, 'model') || 'Hikvision'}</span></div>
            <div className="kv"><span className="kv-k">Purpose</span><span className="kv-v">{purposePill(pickS(dev, 'device_purpose'))}</span></div>
            <div className="kv"><span className="kv-k">Company</span><span className="kv-v">{pickS(dev, 'company_name')}</span></div>
            <div className="kv"><span className="kv-k">Branch</span><span className="kv-v">{pickS(dev, 'branch_name')}</span></div>
            <div className="kv"><span className="kv-k">Department</span><span className="kv-v">{pickS(dev, 'department_name')}</span></div>
            <div className="kv"><span className="kv-k">Facility</span><span className="kv-v">{pickS(dev, 'facility')}</span></div>
            <div className="kv"><span className="kv-k">Physical location</span><span className="kv-v">{pickS(dev, 'physical_location')}</span></div>
            <div className="kv"><span className="kv-k">IP address</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(dev, 'ip_address')}</span></div>
            <div className="kv"><span className="kv-k">MAC address</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(dev, 'mac_address')}</span></div>
            <div className="kv"><span className="kv-k">Timezone</span><span className="kv-v">{pickS(dev, 'timezone')}</span></div>
            <div className="kv"><span className="kv-k">Firmware</span><span className="kv-v">{pickS(dev, 'firmware_version')}</span></div>
            <div className="kv"><span className="kv-k">Key prefix</span><span className="kv-v" style={{ fontFamily: 'var(--mono)' }}>{pickS(dev, 'auth_key_prefix')}</span></div>
            <div className="kv"><span className="kv-k">Status</span><span className="kv-v">{statusPill(pickS(dev, 'connection_status'), DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL)}</span></div>
            <div className="kv"><span className="kv-k">Status reason</span><span className="kv-v">{pickS(dev, 'status_reason')}</span></div>
            <div className="kv"><span className="kv-k">Last heartbeat</span><span className="kv-v">{fmtWhen(pickS(dev, 'last_heartbeat_at'))}</span></div>
            <div className="kv"><span className="kv-k">Last event</span><span className="kv-v">{fmtWhen(pickS(dev, 'last_event_at'))}</span></div>
            <div className="kv"><span className="kv-k">Clock drift</span><span className="kv-v"><DriftText sec={pickS(dev, 'last_clock_drift_seconds')} /></span></div>
            <div className="kv"><span className="kv-k">Enabled</span><span className="kv-v">{pickB(dev, 'enabled') ? 'Yes' : 'No'}</span></div>
          </div>
          <div className="section-title" style={{ marginTop: 18 }}>Quick status</div>
          <div className="hk-inline">
            {STATUSES.map((s) => {
              const current = pickS(dev, 'connection_status');
              return (
                <button key={s} type="button" className="btn btn-sm" disabled={current === s}
                  onClick={() => void changeStatus(dev, s)}>
                  {current === s ? DEVICE_STATUS_LABEL[s] + ' (current)' : 'Mark ' + DEVICE_STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
          <div className="section-title" style={{ marginTop: 18 }}>Operational configuration</div>
          <div className="table-wrap">
            <table className="mini-table">
              <tbody>
                {[
                  ['Attendance events enabled', pickB(cfg, 'attendance_enabled') ? 'Yes' : 'No'],
                  ['Access events enabled', pickB(cfg, 'access_events_enabled') ? 'Yes' : 'No'],
                  ['Duplicate window', pickS(cfg, 'duplicate_window_seconds', '30') + ' seconds'],
                  ['Replay window', pickS(cfg, 'replay_window_seconds', '60') + ' seconds'],
                  ['Allowed future skew', pickS(cfg, 'allow_future_minutes', '5') + ' minutes'],
                  ['Allowed past skew', pickS(cfg, 'allow_past_minutes', '1440') + ' minutes'],
                  ['Break window', (pickS(cfg, 'break_start') || '?') + ' - ' + (pickS(cfg, 'break_end') || '?')],
                  ['Default shift code', pickS(cfg, 'default_shift_code')],
                  ['Clock drift warning', pickS(cfg, 'clock_drift_warning_seconds', '180') + ' seconds'],
                  ['Heartbeat stale after', pickS(cfg, 'heartbeat_stale_seconds', '300') + ' seconds'],
                  ['Heartbeat interval', pickS(cfg, 'heartbeat_interval_seconds', '300') + ' seconds'],
                ].map((r) => (
                  <tr key={String(r[0])}>
                    <td style={{ width: '45%' }}>{r[0]}</td>
                    <td>{r[1]}</td>
                  </tr>
                ))}
                {[
                  ['Notify device offline', pickB(cfg, 'notify_device_offline')],
                  ['Notify device online', pickB(cfg, 'notify_device_online')],
                  ['Notify clock drift', pickB(cfg, 'notify_clock_drift')],
                  ['Notify unknown employee', pickB(cfg, 'notify_unknown_employee')],
                  ['Notify integration failure', pickB(cfg, 'notify_integration_failure')],
                ].map((r) => (
                  <tr key={String(r[0])}>
                    <td>{r[0]}</td>
                    <td>{r[1] ? '\u2713 Yes' : '\u2715 No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="hk-locations-grid">
            <div>
              <div className="section-title" style={{ marginTop: 18 }}>Placement history</div>
              {((detail?.locations ?? []) as Rec[]).length === 0 ? (
                <p className="hk-note">No location placements recorded for this device.</p>
              ) : (
                <div className="table-wrap">
                  <table className="mini-table">
                    <thead><tr><th>Facility / location</th><th>Zone</th><th>Active</th><th>From</th></tr></thead>
                    <tbody>
                      {((detail?.locations ?? []) as Rec[]).map((l) => (
                        <tr key={pickS(l, 'id')}>
                          <td>{pickS(l, 'facility')}<div className="muted" style={{ fontSize: 11 }}>{pickS(l, 'physical_location')}</div></td>
                          <td>{pickS(l, 'zone') || '-'}</td>
                          <td>{pickB(l, 'is_active') ? 'Yes' : 'No'}</td>
                          <td>{fmtWhen(pickS(l, 'effective_from'))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <div className="section-title" style={{ marginTop: 18 }}>Recent activity</div>
              {((detail?.recentEvents ?? []) as Rec[]).length === 0 ? (
                <p className="hk-note">No raw events received from this device yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="mini-table">
                    <thead><tr><th>Time</th><th>Event</th><th>Status</th></tr></thead>
                    <tbody>
                      {((detail?.recentEvents ?? []) as Rec[]).map((e) => (
                        <tr key={pickS(e, 'id')}>
                          <td className="time-chip">{fmtWhen(pickS(e, 'device_event_time'))}</td>
                          <td>{toStr(e.event_type)}</td>
                          <td>{statusPill(pickS(e, 'processing_status'), RAW_STATUS_TONE)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          <div className="section-title" style={{ marginTop: 18 }}>Heartbeats</div>
          {((detail?.heartbeats ?? []) as Rec[]).length === 0 ? (
            <p className="hk-note">No heartbeats recorded. Terminals send heartbeats on the configured interval.</p>
          ) : (
            <div className="table-wrap hk-scroll-x">
              <table className="mini-table">
                <thead><tr><th>Heartbeat at</th><th>Device time</th><th>Clock drift</th><th>IP</th><th>Firmware</th></tr></thead>
                <tbody>
                  {((detail?.heartbeats ?? []) as Rec[]).map((h) => (
                    <tr key={pickS(h, 'id')}>
                      <td>{fmtWhen(pickS(h, 'heartbeat_at'))}</td>
                      <td className="time-chip">{pickS(h, 'device_time')}</td>
                      <td><DriftText sec={pickS(h, 'clock_drift_seconds')} /></td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(h, 'ip_address') || '-'}</td>
                      <td>{pickS(h, 'firmware_version') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="section-title" style={{ marginTop: 18 }}>Health log</div>
          {((detail?.healthLogs ?? []) as Rec[]).length === 0 ? (
            <p className="hk-note">No health transitions recorded.</p>
          ) : (
            <div className="table-wrap">
              <table className="mini-table">
                <thead><tr><th>When</th><th>Type</th><th>Severity</th><th>Transition</th><th>Message</th></tr></thead>
                <tbody>
                  {((detail?.healthLogs ?? []) as Rec[]).map((h) => (
                    <tr key={pickS(h, 'id')}>
                      <td>{fmtWhen(pickS(h, 'created_at'))}</td>
                      <td>{pickS(h, 'health_type').replace(/_/g, ' ')}</td>
                      <td>{statusPill(pickS(h, 'severity'), SEVERITY_TONE)}</td>
                      <td className="muted">{pickS(h, 'previous_status')} {'\u2192'} {pickS(h, 'new_status')}</td>
                      <td>{pickS(h, 'message')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      ) : null}
      {formMode ? (
        <DeviceForm
          mode={formMode}
          device={formDevice}
          configuration={formCfg}
          userCompanyId={user ? toNum(user.company_id) || null : null}
          onClose={() => { setFormMode(null); setFormDevice(null); setFormCfg(null); }}
          onSaved={reloadAll}
        />
      ) : null}
      {confirmDel ? (
        <Modal
          title={'Delete ' + pickS(confirmDel, 'name')}
          onClose={() => setConfirmDel(null)}
          footer={
            <>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void doDelete()}>Delete device</button>
            </>
          }
        >
          <p style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            Deleting a terminal with historical raw events disables it instead so the audit trail is preserved.
            The action is recorded in the audit log.
          </p>
          <Field label="Reason (recommended)">
            <Txa value={delReason} onChange={setDelReason} placeholder="Why is this device being removed?" />
          </Field>
        </Modal>
      ) : null}
      <p className="muted hint" style={{ marginTop: 8 }}>
        Webhook events authenticate against the device serial number and the one-time device key.
        Store keys securely; they are shown only once and can be rotated from the device detail panel.
      </p>
    </div>
  );
}

