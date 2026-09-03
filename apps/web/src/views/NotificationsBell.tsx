import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api';
import { navigate } from '../router';
import { eventLabel, pick } from '../helpers';

type Rec = Record<string, unknown>;

function prioBadge(p: unknown) {
  const raw = String(p ?? '').toUpperCase();
  const tone =
    raw === 'CRITICAL' ? 'badge-critical'
    : raw === 'URGENT' ? 'badge-red'
    : raw === 'HIGH' ? 'badge-amber'
    : raw === 'NORMAL' ? 'badge-blue'
    : 'badge-neutral';
  if (!raw) return null;
  return <span className={`badge ${tone}`}>{raw}</span>;
}

function goTarget(t: unknown) {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (s.startsWith('#/')) return s.slice(1);
  if (s.startsWith('#')) return s.slice(1);
  return s.startsWith('/') ? s : `/${s}`;
}

function relativeTime(v: unknown): string {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) return fmtDate(v);
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString('en-UG');
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

function inboxRows(body: { data?: unknown }): Rec[] {
  const data = body?.data;
  if (Array.isArray(data)) return data as Rec[];
  if (data && typeof data === 'object' && Array.isArray((data as { rows?: Rec[] }).rows)) {
    return (data as { rows: Rec[] }).rows;
  }
  return [];
}

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread' | 'urgent'>('unread');
  const [q, setQ] = useState('');
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Rec[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
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
      const r = await api<{ data: unknown }>(`/api/notifications?${qs.toString()}`);
      setItems(inboxRows(r));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load notifications');
      setItems([]);
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setMenuFor(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = async (id: number, path: string, method: string, body?: unknown) => {
    if (busyId === id) return;
    setBusyId(id);
    try {
      await api(`/api/notifications${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      await Promise.all([load(), refreshCount()]);
      setError('');
    } catch {
      setError('Action failed — please try again.');
    } finally {
      setBusyId(null);
      setMenuFor(null);
    }
  };

  const act = (n: Rec) => {
    if (!pick(n, 'readAt', 'read_at')) void run(Number(n.id), `/${String(n.id)}/read`, 'PATCH');
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

  const badge = count > 99 ? '99+' : String(count);

  return (
    <div className="topbar-item" ref={rootRef}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="Notifications" aria-label="Notifications">
        <span aria-hidden>🔔</span>
        {count > 0 && <span className="count-badge">{badge}</span>}
      </button>
      {open ? (
        <>
          <div className="com-bell-backdrop" onClick={() => { setOpen(false); setMenuFor(null); }} aria-hidden />
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
              {error ? <p className="com-bell-error">{error}</p> : null}
              {items.length === 0 && !error ? (
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
                  const body = pick(n, 'body');
                  return (
                    <article
                      key={String(n.id)}
                      className={'com-notif com-bell-row' + (unread ? ' com-notif-unread' : '')}
                      onClick={() => act(n)}
                    >
                      <div className="com-notif-top">
                        <span className="com-notif-title">{String(pick(n, 'title') ?? 'Notification')}</span>
                        {prioBadge(pick(n, 'priority'))}
                      </div>
                      {body ? <p className="com-notif-body">{String(body)}</p> : null}
                      <div className="com-notif-meta">
                        <span>{relativeTime(pick(n, 'createdAt', 'created_at'))}</span>
                        {pick(n, 'type') ? <span>{eventLabel(pick(n, 'type'))}</span> : null}
                      </div>
                      <div className="com-bell-row-actions" onClick={(e) => e.stopPropagation()}>
                        {actionLabel || actionTarget ? (
                          <button className="btn btn-sm btn-primary" type="button" onClick={() => act(n)}>{actionLabel || 'Open'}</button>
                        ) : unread ? (
                          <button className="btn btn-sm" type="button" disabled={busyId === id} onClick={() => void run(id, `/${id}/read`, 'PATCH')}>Mark read</button>
                        ) : null}
                        <div className="com-bell-snooze">
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setMenuFor(menuFor === id ? null : id)} aria-label="More">⋯</button>
                          {menuFor === id ? (
                            <div className="com-bell-snooze-menu">
                              {unread
                                ? <button type="button" onClick={() => void run(id, `/${id}/read`, 'PATCH')}>Mark read</button>
                                : <button type="button" onClick={() => void run(id, `/${id}/unread`, 'PATCH')}>Mark unread</button>}
                              <button type="button" onClick={() => void run(id, `/${id}/archive`, 'PATCH')}>Archive</button>
                              {SNOOZE.map((s) => (
                                <button key={s.label} type="button" onClick={() => void run(id, `/${id}/snooze`, 'PATCH', { until: s.until() })}>
                                  Snooze {s.label}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            <div className="com-bell-foot">
              <button className="btn btn-ghost" type="button" onClick={() => {
                void api('/api/notifications/read-all', { method: 'POST' })
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
