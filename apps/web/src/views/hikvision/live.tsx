import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { navigate } from '../../router';
import { useAuth, can } from '../../auth';
import { ErrorBanner, PageLoader } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS,
  verifPill, empName, empNo,
  EVENT_TYPE_LABEL,
  fmtWhen, fmtStatusLabel,
} from './shared';

const SECONDARY_TABS: { id: string; label: string; href: string; perm: string }[] = [
  { id: 'd', label: 'Live Attendance', href: '/hikvision', perm: 'hikvision.dashboard.view' },
  { id: 'm', label: 'Devices', href: '/hikvision/devices', perm: 'hikvision.devices.view' },
];

function KpiTile({ label, value, sub, onClick, tone }: { label: string; value: unknown; sub?: string; onClick?: () => void; tone?: string }) {
  return (
    <button type="button" className="kpi-card" onClick={onClick} disabled={!onClick} style={onClick ? undefined : { cursor: 'default' }}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={tone ? { color: tone } : undefined}>{toNum(value)}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </button>
  );
}

export default function LiveBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [lastTick, setLastTick] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/hikvision/dashboard');
      setData(r.data);
      setLastTick(new Date().toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Live dashboard failed');
    }
  }, []);
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 8000);
    return () => clearInterval(iv);
  }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading live attendance..." />;

  const deviceCounts = (data.deviceCounts ?? {}) as Rec;
  const eventsToday = (data.eventsToday ?? {}) as Rec;
  const attendanceToday = (data.attendanceToday ?? {}) as Rec;
  const byStatus = (attendanceToday.byStatus ?? {}) as Rec;
  const feed = (data.feed ?? []) as Rec[];
  const online = toNum(deviceCounts.ONLINE, toNum(data.devicesOnline));
  const offline = toNum(deviceCounts.OFFLINE, toNum(data.devicesOffline));
  const warnings = toNum(deviceCounts.WARNING, toNum(data.warnings));
  const maintenance = toNum(deviceCounts.MAINTENANCE);
  const evTotal = toNum(eventsToday.total);

  const present = toNum(attendanceToday.presentToday, toNum(byStatus.PRESENT));
  const checkedIn = toNum(attendanceToday.checkedIn);
  const late = toNum(attendanceToday.late, toNum(byStatus.LATE));
  const absent = toNum(attendanceToday.absent, toNum(byStatus.ABSENT));
  const onLeave = toNum(attendanceToday.onLeave, toNum(byStatus.ON_LEAVE));
  const excOpen = toNum(data.exceptionsOpen);

  return (
    <div className="page">
      <HikHead
        title="Live Attendance"
        subtitle="Real-time biometric and card activity from Hikvision terminals."
        actions={
          <div className="head-actions">
            <span className="muted" style={{ marginRight: 8 }}>Updated {lastTick || '\u2014'}</span>
            {can(user, 'hikvision.health.view') ? (
              <button type="button" className="btn btn-sm" onClick={() => navigate('/hikvision/health')}>Device health</button>
            ) : null}
            {can(user, 'hikvision.exceptions.view') ? (
              <button type="button" className="btn btn-sm" onClick={() => navigate('/hikvision/exceptions')}>Exceptions</button>
            ) : null}
          </div>
        }
      />
      <HikTabs active="live" />
      <div className="hk-band-actions">
        {SECONDARY_TABS.filter((t) => can(user, t.perm)).map((t) => (
          <button key={t.id} type="button" className="btn btn-sm btn-ghost" onClick={() => navigate(t.href)}>{t.label}</button>
        ))}
      </div>
      <div className="kpi-grid hk-kpi-5">
        <KpiTile label="Present Today" value={present} sub="Present + late + early + half day" onClick={() => navigate('/hikvision/attendance')} tone="var(--ok)" />
        <KpiTile label="Checked In" value={checkedIn} sub="Punch events processed today" onClick={() => navigate('/hikvision/events')} />
        <KpiTile label="Late" value={late} sub="Late arrivals today" onClick={() => navigate('/hikvision/attendance')} tone="var(--warn)" />
        <KpiTile label="Absent" value={absent} sub="No show today" onClick={() => navigate('/hikvision/exceptions')} tone="var(--danger)" />
        <KpiTile label="On Leave" value={onLeave} sub="Approved leave today" onClick={() => navigate('/people/leave')} />
      </div>
      <div className="grid-2 hk-board-grid">
        <section className="card card-pad">
          <div className="card-head">
            <h3>Live activity feed</h3>
            <span className="muted">{feed.length} latest events</span>
          </div>
          {feed.length === 0 ? (
            <div className="empty-state">
              <h3>No recent events</h3>
              <p>Terminal punches will appear here in real time as the queue worker processes them.</p>
            </div>
          ) : (
            <ul className="feed hk-feed">
              {feed.map((f) => {
                const emp = (f.employee ?? null) as Rec | null;
                const dev = (f.device ?? {}) as Rec;
                const name = emp ? empName(emp) : 'Unknown employee ID';
                const unknown = !emp;
                const rawType = toStr(f.eventType);
                const label = EVENT_TYPE_LABEL[toStr(f.normalizedType || f.eventType).toUpperCase()] ?? (rawType || 'Punch');
                return (
                  <li className={'feed-item' + (unknown ? ' hk-feed-warn' : '')} key={String(f.rawEventId ?? f.id ?? name + String(f.eventTime))}>
                    <span className="feed-icon">{unknown ? '\u26A0' : '\u2713'}</span>
                    <div className="feed-body">
                      <div className="feed-title">
                        <strong>{name}</strong>
                        <span className="muted">{empNo(emp) ? empNo(emp) : toStr(f.employeeIdentifier)}</span>
                      </div>
                      <div className="feed-meta">
                        <span>{label}</span>
                        {verifPill(f.verificationMethod)}
                        <span>{pickS(dev, 'name') || pickS(dev, 'location') || 'Terminal'} {pickS(dev, 'location') ? '\u2022 ' + pickS(dev, 'location') : ''}</span>
                      </div>
                    </div>
                    <time className="feed-time">{fmtWhen(f.eventTime)}</time>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <div className="hk-side-stack">
          <section className="card card-pad">
            <div className="card-head">
              <h3>Terminals</h3>
              <button type="button" className="btn btn-sm" onClick={() => navigate('/hikvision/devices')}>Manage</button>
            </div>
            <div className="def-sec">
              <div className="hk-stat-row"><span>Devices online</span><strong>{online}</strong></div>
              <div className="hk-stat-row"><span>Devices offline</span><strong>{offline}</strong></div>
              <div className="hk-stat-row"><span>Warnings</span><strong>{warnings}</strong></div>
              <div className="hk-stat-row"><span>Maintenance</span><strong>{maintenance}</strong></div>
            </div>
            <div className="chip-row">
              {online > 0 ? <span className="chip chip-green">{online} online</span> : null}
              {offline > 0 ? <span className="chip chip-amber">{offline} offline</span> : null}
              {warnings > 0 ? <span className="chip chip-red">{warnings} warning</span> : null}
            </div>
          </section>
          <section className="card card-pad">
            <div className="card-head">
              <h3>Events today</h3>
              <span className="muted">{evTotal} total</span>
            </div>
            <div className="hk-meter-row">
              {['processed', 'duplicates', 'failed', 'rejected', 'pending'].map((k) => {
                const v = toNum(eventsToday[k]);
                const pct = evTotal > 0 ? Math.round((v / evTotal) * 100) : 0;
                return (
                  <div className="hk-meter" key={k}>
                    <div className="hk-meter-label"><span>{fmtStatusLabel(k)}</span><strong>{v}</strong></div>
                    <div className="hk-meter-track"><div className={'hk-meter-fill hk-meter-' + k} style={{ width: Math.min(100, pct) + '%' }} /></div>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card card-pad">
            <div className="card-head">
              <h3>Exceptions</h3>
              <button type="button" className="btn btn-sm" onClick={() => navigate('/hikvision/exceptions')}>Open</button>
            </div>
            <p style={{ fontSize: 30, fontWeight: 700, color: excOpen > 0 ? 'var(--danger)' : 'var(--ok)' }}>{excOpen}</p>
            <p className="muted">Open exceptions require review and resolution before approval.</p>
          </section>
        </div>
      </div>
      <p className="muted hint">Every event is stored raw before validation, then queued for processing. Duplicate and failed events are preserved for audit, never deleted.</p>
    </div>
  );
}

