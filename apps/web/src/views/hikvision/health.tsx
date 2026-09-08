import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { ErrorBanner, PageLoader } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS,
  DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL,
  statusPill, purposePill, fmtWhen, durLabel, exportCsv,
} from './shared';
import { isoToday } from './hkutil';

const STATUS_OPTIONS = Object.keys(DEVICE_STATUS_LABEL);

function StatTile({ label, value, tone, sub }: { label: string; value: unknown; tone?: string; sub?: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={tone ? { color: tone } : undefined}>{toNum(value)}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}

export default function HealthBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [lastTick, setLastTick] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [syncNote, setSyncNote] = useState('');
  const canTimeSync = can(user, 'hikvision.configuration.manage');

  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/health');
      setData(r.data);
      setLastTick(new Date().toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Device health board failed');
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  const allDevices = useMemo<Rec[]>(() => (data?.devices ?? []) as Rec[], [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ONLINE: 0, OFFLINE: 0, WARNING: 0, MAINTENANCE: 0, DISABLED: 0 };
    for (const d of allDevices) {
      const s = toStr(d.connectionStatus).toUpperCase();
      if (c[s] !== undefined) c[s] += 1;
    }
    return c;
  }, [allDevices]);
  const eventsToday = allDevices.reduce((n, d) => n + toNum(d.eventsToday), 0);
  const openExceptions = allDevices.reduce((n, d) => n + toNum(d.exceptionsOpen), 0);
  const warnings = allDevices.filter((d) => toStr(d.connectionStatus).toUpperCase() === 'WARNING');

  const visible = allDevices.filter((d) => {
    if (status && toStr(d.connectionStatus).toUpperCase() !== status) return false;
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return [pickS(d, 'code'), pickS(d, 'name'), pickS(d, 'model'), pickS(d, 'serialNumber'), pickS(d, 'ipAddress'), pickS(d, 'branchName')]
      .some((v) => v.toLowerCase().includes(t));
  });

  const doTimeSync = async (dev: Rec, remote: boolean) => {
    if (!canTimeSync) return;
    setBusyId(toNum(dev.id));
    setSyncNote('');
    try {
      await api('/api/hikvision/devices/' + toStr(dev.id) + '/time-sync', {
        method: 'POST',
        body: JSON.stringify({
          syncType: remote ? 'SYNC_REMOTE_ISAPI' : 'RECORD_LOCAL',
          reason: remote ? 'Operator requested terminal clock synchronisation.' : 'Operator recorded server reference time.',
        }),
      });
      setSyncNote('Clock sync recorded for ' + pickS(dev, 'name') + '.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clock sync failed');
    } finally {
      setBusyId(null);
    }
  };

  const exportRows = visible.map((d) => [
    pickS(d, 'code'), pickS(d, 'name'), pickS(d, 'model'), pickS(d, 'serialNumber'),
    pickS(d, 'ipAddress'), pickS(d, 'branchName'), pickS(d, 'departmentName'),
    toStr(d.devicePurpose), toStr(d.connectionStatus), toStr(d.enabled ? 'yes' : 'no'),
    pickS(d, 'timezone'), pickS(d, 'firmwareVersion'), fmtWhen(d.lastHeartbeatAt),
    fmtWhen(d.lastEventAt), toNum(d.lastClockDriftSeconds) > 0 ? durLabel(d.lastClockDriftSeconds) : 'n/a',
    toNum(d.eventsToday), toNum(d.exceptionsOpen),
  ]);

  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading device health..." />;

  return (
    <div className="page">
      <HikHead
        title="Hikvision Device Health"
        subtitle="Terminal connectivity, clock drift, event flow and integration failures."
        actions={<span className="muted">Updated {lastTick || '\u2014'} · {isoToday()}</span>}
      />
      <HikTabs active="health" />
      {error ? <ErrorBanner error={error} /> : null}
      {syncNote ? <div className="notice-banner" style={{ marginTop: 10 }}>{syncNote}</div> : null}

      <div className="kpi-grid hk-kpi-6">
        <StatTile label="Devices Online" value={counts.ONLINE} tone="var(--ok)" sub="Accepting events" />
        <StatTile label="Devices Offline" value={counts.OFFLINE} tone="var(--danger)" sub="Heartbeat expired" />
        <StatTile label="Warnings" value={counts.WARNING} tone="var(--warn)" sub="Clock drift / degraded" />
        <StatTile label="Maintenance" value={counts.MAINTENANCE} sub="Planned work" />
        <StatTile label="Events Today" value={eventsToday} sub="Raw events received" />
        <StatTile label="Open Exceptions" value={openExceptions} sub="Needs attention" />
      </div>

      {warnings.length > 0 ? (
        <section className="card card-pad" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Clock drift · warning</h3>
            <span className="muted">{warnings.length} terminal(s)</span>
          </div>
          <ul className="feed hk-feed">
            {warnings.map((w) => (
              <li className="feed-item" key={toStr(w.id)}>
                <span className="feed-icon">{'\u26A0'}</span>
                <div className="feed-body">
                  <div className="feed-title"><strong>{pickS(w, 'name')}</strong><span className="muted">{pickS(w, 'serialNumber')}</span></div>
                  <div className="feed-meta">
                    {toNum(w.lastClockDriftSeconds) > 0 ? (
                      <span className="badge badge-amber">Clock difference: {durLabel(w.lastClockDriftSeconds)}</span>
                    ) : null}
                    {toStr(w.statusReason) ? <span className="muted">{toStr(w.statusReason)}</span> : null}
                  </div>
                </div>
                {canTimeSync ? (
                  <button type="button" className="btn btn-sm" disabled={busyId === toNum(w.id)} onClick={() => void doTimeSync(w, true)}>
                    {busyId === toNum(w.id) ? 'Syncing\u2026' : 'Sync clock'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Terminals</h3>
          <div className="head-actions" style={{ flexWrap: 'wrap' }}>
            <select className="hk-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{DEVICE_STATUS_LABEL[s]}</option>)}
            </select>
            <input className="hk-input" style={{ width: 220 }} placeholder={'Search device / branch\u2026'} value={q} onChange={(e) => setQ(e.target.value)} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => exportCsv('hikvision-device-health-' + isoToday(), [
                'Code', 'Name', 'Model', 'Serial', 'IP', 'Branch', 'Department', 'Purpose', 'Status',
                'Enabled', 'Timezone', 'Firmware', 'Last heartbeat', 'Last event', 'Clock drift', 'Events today', 'Open exceptions',
              ], exportRows)}
            >Export CSV</button>
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="empty-state"><h3>No devices</h3><p>Register terminals under Devices to start monitoring them here.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th><th>Purpose</th><th>Status</th><th>Clock drift</th>
                  <th>Last heartbeat</th><th>Last event</th><th>Events</th><th>Exceptions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => {
                  const drift = toNum(d.lastClockDriftSeconds);
                  return (
                    <tr key={toStr(d.id)}>
                      <td>
                        <div className="emp-cell">
                          <div>
                            <strong>{pickS(d, 'name')}</strong>
                            <span className="muted">{pickS(d, 'code')} · {pickS(d, 'model')} · {pickS(d, 'serialNumber')}</span>
                            <span className="muted">{pickS(d, 'ipAddress')}{pickS(d, 'branchName') ? ' · ' + pickS(d, 'branchName') : ''}{pickS(d, 'departmentName') ? ' · ' + pickS(d, 'departmentName') : ''}</span>
                          </div>
                        </div>
                      </td>
                      <td>{purposePill(d.devicePurpose)}</td>
                      <td>{statusPill(d.connectionStatus, DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL)}</td>
                      <td>
                        {drift > 0 ? (
                          <span className={'badge ' + (drift > 300 ? 'badge-amber' : 'badge-neutral')}>{durLabel(drift)}</span>
                        ) : (
                          <span className="muted">n/a</span>
                        )}
                      </td>
                      <td><span className="muted">{fmtWhen(d.lastHeartbeatAt)}</span></td>
                      <td><span className="muted">{fmtWhen(d.lastEventAt)}</span></td>
                      <td><strong>{toNum(d.eventsToday)}</strong></td>
                      <td>{toNum(d.exceptionsOpen) > 0 ? <span className="badge badge-amber">{toNum(d.exceptionsOpen)}</span> : <span className="muted">0</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}