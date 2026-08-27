import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api';
import { pick } from '../helpers';

interface Notif {
  id: number;
  title: string;
  body?: string | null;
  type?: string | null;
  created_at?: string | null;
  read_at?: string | null;
  [key: string]: unknown;
}

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Notif[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ count: number }>('/api/notifications/unread-count');
      setCount(r.count);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [refresh]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        const r = await api<{ data: Notif[] }>('/api/notifications?pageSize=8');
        setItems(r.data);
      } catch { setItems([]); }
    }
  };

  const markRead = async (id: number) => {
    try {
      await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
      setItems((xs) => xs.filter((x) => x.id !== id));
      refresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="topbar-item" ref={ref}>
      <button className="icon-btn" onClick={toggle} title="Notifications">
        🔔 {count > 0 && <span className="count-badge">{count}</span>}
      </button>
      {open && (
        <div className="topbar-dropdown">
          <div className="dropdown-head">Notifications</div>
          <button className="search-item" onClick={async () => {
            await Promise.all(items.map((n) => api(`/api/notifications/${n.id}/read`, { method: 'PATCH' }).catch(() => undefined)));
            setItems([]); refresh();
          }}>Mark all read</button>
          {items.length === 0 && <div className="search-hint">No notifications</div>}
          {items.map((n) => (
            <div key={n.id} className="notif-item" onClick={() => markRead(n.id)}>
              <div className="notif-title">{n.title}</div>
              <div className="notif-body">{pick<string>(n, 'body', 'message') ?? ''}</div>
              <div className="notif-time">{fmtDate(pick(n, 'created_at', 'createdAt'))}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
