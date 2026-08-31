import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api';
import { navigate } from '../router';
import { pick } from '../helpers';

type Rec = Record<string, unknown>;

function prioBadge(p: unknown) {
  const raw = String(p ?? '').toUpperCase();
  const tone =
    raw === 'CRITICAL' ? 'badge-critical'
    : raw === 'URGENT' ? 'badge-red'
    : raw === 'HIGH' ? 'badge-amber'
    : raw === 'NORMAL' ? 'badge-blue'
    : 'badge-neutral';
  const icon = raw === 'CRITICAL' ? '\u2715' : raw === 'URGENT' || raw === 'HIGH' ? '!' : '\u25CF';
  if (!raw) return null;
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-icon" aria-hidden>{icon}</span>
      {raw}
    </span>
  );
}

function goTarget(t: unknown) {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (s.startsWith('#/')) return s.slice(1);
  if (s.startsWith('#')) return s.slice(1);
  return s.startsWith('/') ? s : `/${s}`;
}

const SNOOZE: { label: string; until: () => string }[] = [
  { label: '1 hour', until: () => new Date(Date.now() + 3600e3).toISOString() },
  { label: '4 hours', until: () => new Date(Date.now() + 4 * 3600e3).toISOString() },
  {
    label: 'Tomorrow 9:00',
    until: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    },
  },
];

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread' | 'urgent'>('unread');
  const [q, setQ] = useState('');
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Rec[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<number | null>(null);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const r = await api<{ count: number }>('/api/notifications/unread-count');
      setCount(r.count);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('pageSize', '25');
    if (tab === 'unread') qs.set('unread', 'true');
    if (tab === 'urgent') qs.set('urgent', 'true');
    if (q.trim()) qs.set('q', q.trim());
    try {
      const r = await api<{ data: { rows: Rec[] } }>(`/api/ops/communication/notifications?${qs.toString()}`);
      setItems(r.data.rows ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load notifications');
    }
  }, [tab, q]);

  useEffect(() => {
    refreshCount();
    const iv = window.setInterval(refreshCount, 30000);
    return () => window.clearInterval(iv);
  }, [refreshCount]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = async (id: number, path: string, method: string, body?: unknown) => {
    if (busyId === id) return;
    setBusyId(id);
    try {
      await api(`/api/ops/communication${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      await Promise.all([load(), refreshCount()]);
      setError('');
    } catch {
      setError('Action failed — please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const act = (n: Rec) => {
    if (!pick(n, 'readAt', 'read_at')) void run(Number(n.id), `/notifications/${String(n.id)}/read`, 'PATCH');
    const target = goTarget(pick(n, 'actionTarget', 'action_target', 'link'));
    if (target) {
      setOpen(false);
      navigate(target);
    }
  };

  const openCenter = () => {
    setOpen(false);
    navigate('/communication/notifications');
  };

  return (
    <div className="topbar-item" ref={rootRef}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="Notifications" aria-label="Notifications">
        {count > 0 && <span className="count-badge">{count}</span>}
      </button>
      {open ? (
        <>
          <div className="com-bell-backdrop" onClick={() => setOpen(false)} aria-hidden />
          <aside className="com-bell-drawer" role="dialog" aria-label="Notifications">
            <div className="com-bell-head">
              <div>
                <h3>Notifications</h3>
                <span className="muted">{count} unread</span>
              </div>
              <button className="icon-btn" onClick={() => setOpen(false)} title="Close" aria-label="Close">✕</button>
            </div>
            <div className="com-bell-tabs" role="tablist" aria-label="Notification filters">
              {(['all', 'unread', 'urgent'] as const).map((t) => (
                <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
                  {t === 'all' ? 'All' : t === 'unread' ? 'Unread' : 'Urgent'}
                </button>
              ))}
            </div>
            <div className="com-bell-tools">
              <input className="search-input" placeholder="Search notifications…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notifications" />
            </div>
            <div className="com-bell-body">
              {error ? <p className="muted com-bell-error">{error}</p> : null}
              {items.length === 0 ? (
                <div className="empty-state">
                  <h3>You're all caught up</h3>
                  <p>No notifications in this view right now.</p>
                </div>
              ) : (
                items.map((n) => {
                  const id = Number(n.id);
                  const unread = !pick(n, 'readAt', 'read_at');
                  const actionLabel = pick<string>(n, 'actionLabel', 'action_label');
                  const actionTarget = pick(n, 'actionTarget', 'action_target', 'link');
                  return (
                    <div key={String(n.id)} className={'com-notif com-bell-row' + (unread ? ' com-notif-unread' : '')}>
                      <div className="com-notif-top">
                        <span className="com-notif-title">{String(pick(n, 'title') ?? 'Notification')}</span>
                        {prioBadge(pick(n, 'priority'))}
                      </div>
                      {pick(n, 'body') ? <p className="com-notif-body">{String(pick(n, 'body'))}</p> : null}
                      <div className="com-notif-meta">
                        <span>{fmtDate(pick(n, 'createdAt', 'created_at'))}</span>
                        {pick(n, 'type') ? <span>{String(pick(n, 'type'))}</span> : null}
                      </div>
                      <div className="com-bell-row-actions">
                        {actionLabel || actionTarget ? (
                          <button className="btn btn-sm" type="button" onClick={() => act(n)}>{actionLabel || 'Open'}</button>
                        ) : null}
                        {unread ? (
                          <button className="btn btn-sm btn-ghost" type="button" disabled={busyId === id} onClick={() => void run(id, `/notifications/${String(n.id)}/read`, 'PATCH')}>Read</button>
                        ) : (
                          <button className="btn btn-sm btn-ghost" type="button" disabled={busyId === id} onClick={() => void run(id, `/notifications/${String(n.id)}/unread`, 'PATCH')}>Unread</button>
                        )}
                        <button className="btn btn-sm btn-ghost" type="button" disabled={busyId === id} onClick={() => void run(id, `/notifications/${String(n.id)}/archive`, 'PATCH')}>Archive</button>
                        <div className="com-bell-snooze">
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setSnoozeFor(snoozeFor === id ? null : id)}>Snooze</button>
                          {snoozeFor === id ? (
                            <div className="com-bell-snooze-menu">
                              {SNOOZE.map((s) => (
                                <button key={s.label} type="button" onClick={() => { void run(id, `/notifications/${String(n.id)}/snooze`, 'PATCH', { until: s.until() }); setSnoozeFor(null); }}>
                                  {s.label}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="com-bell-foot">
              <button className="btn btn-ghost" type="button" onClick={() => {
                void api('/api/ops/communication/notifications/read-all', { method: 'POST' })
                  .then(() => Promise.all([load(), refreshCount()]))
                  .catch(() => undefined);
              }}>Mark all read</button>
              <button className="btn btn-primary" type="button" onClick={openCenter}>Open Center</button>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}