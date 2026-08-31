import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, fmtDate } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { pick, titleCase } from '../helpers';
import { pathForEntity } from '../work';

type Rec = Record<string, unknown>;

function parseCom(path: string): { view: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'communication') return { view: 'center', id: null };
  return { view: parts[1] ?? 'center', id: parts[2] ?? null };
}

function prioTone(p: unknown): string {
  const raw = String(p ?? '').toUpperCase();
  if (raw === 'CRITICAL') return 'badge-critical';
  if (raw === 'URGENT') return 'badge-red';
  if (raw === 'HIGH') return 'badge-amber';
  if (raw === 'NORMAL') return 'badge-blue';
  return 'badge-neutral';
}

function prioBadge(p: unknown) {
  const raw = String(p ?? '').toUpperCase();
  if (!raw) return null;
  const icon = raw === 'CRITICAL' ? '\u2715' : raw === 'URGENT' || raw === 'HIGH' ? '!' : '\u25CF';
  return (
    <span className={`badge ${prioTone(p)}`}>
      <span className="badge-icon" aria-hidden>{icon}</span>
      {raw}
    </span>
  );
}

function goTarget(t: unknown): string | null {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (s.startsWith('#/')) return s.slice(1);
  if (s.startsWith('#')) return s.slice(1);
  return s.startsWith('/') ? s : `/${s}`;
}

function fullName(r: Rec): string {
  const f = pick<string>(r, 'firstName', 'first_name');
  const l = pick<string>(r, 'lastName', 'last_name');
  return [f, l].filter(Boolean).join(' ') || String(pick(r, 'username') ?? 'User');
}

function avatarText(r: Rec): string {
  const f = String(pick(r, 'firstName', 'first_name') ?? '');
  const l = String(pick(r, 'lastName', 'last_name') ?? '');
  if (f || l) return ((f[0] ?? '') + (l[0] ?? '')).toUpperCase() || '?';
  const t = String(pick(r, 'title') ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
}

function trunc(s: unknown, n = 110): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '\u2026' : t;
}

function ComTabs({ active }: { active: string }) {
  const { user } = useAuth();
  const daily: { id: string; label: string; href: string; perm: string }[] = [
    { id: 'center', label: 'Command Center', href: '/communication', perm: 'communication.command.view' },
    { id: 'work', label: 'My Work', href: '/communication/work', perm: 'communication.command.view' },
    { id: 'messages', label: 'Messages', href: '/communication/messages', perm: 'communication.messages.view' },
    { id: 'notifications', label: 'Notifications', href: '/communication/notifications', perm: 'communication.notifications.view' },
    { id: 'email', label: 'Inbox', href: '/communication/email', perm: 'communication.emails.view' },
    { id: 'sent', label: 'Sent', href: '/communication/sent', perm: 'communication.emails.view' },
    { id: 'drafts', label: 'Drafts', href: '/communication/drafts', perm: 'communication.emails.view' },
    { id: 'announcements', label: 'Announcements', href: '/communication/announcements', perm: 'communication.announcements.view' },
    { id: 'archive', label: 'Archive', href: '/communication/archive', perm: 'communication.notifications.view' },
  ].filter((t) => can(user, t.perm));
  const admin: { id: string; label: string; href: string; perm: string }[] = [
    { id: 'templates', label: 'Templates', href: '/communication/templates', perm: 'communication.templates.view' },
    { id: 'deliveries', label: 'Delivery Logs', href: '/communication/deliveries', perm: 'communication.delivery_logs.view' },
    { id: 'admin', label: 'Health', href: '/communication/admin', perm: 'communication.command.view' },
    { id: 'settings', label: 'Settings', href: '/communication/settings', perm: 'communication.settings.manage' },
    { id: 'preferences', label: 'My Preferences', href: '/communication/preferences', perm: 'communication.notifications.view' },
    { id: 'rules', label: 'Notification Rules', href: '/communication/rules', perm: 'communication.notifications.manage' },
    { id: 'cron', label: 'Cron Jobs', href: '/communication/cron', perm: 'system.cron.view' },
  ].filter((t) => can(user, t.perm));
  const row = (t: { id: string; label: string; href: string }) => (
    <button key={t.id} className={'tab' + (t.id === active ? ' active' : '')} onClick={() => navigate(t.href)}>
      {t.label}
    </button>
  );
  return (
    <div className="com-tabs-wrap">
      <div className="com-tabs" role="tablist" aria-label="Communication">
        {daily.map(row)}
      </div>
      {admin.length > 0 ? (
        <div className="com-tabs com-tabs-admin" role="tablist" aria-label="Communication administration">
          {admin.map(row)}
        </div>
      ) : null}
    </div>
  );
}

function ComHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="com">Communication</p>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </header>
  );
}

function NotifRow({ n, onChanged, showRead }: { n: Rec; onChanged?: () => void; showRead?: boolean }) {
  const [busy, setBusy] = useState(false);
  const readAt = pick(n, 'readAt', 'read_at');
  const unread = !readAt;
  const ack = pick(n, 'acknowledgedAt', 'acknowledged_at');
  const actionLabel = pick<string>(n, 'actionLabel', 'action_label');
  const actionTarget = pick(n, 'actionTarget', 'action_target', 'link');
  const actionRequired = !!pick(n, 'actionRequired', 'action_required');
  const run = async (path: string, method: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/ops/communication${path}`, { method });
      onChanged?.();
    } catch {
      /* background actions stay quiet */
    } finally {
      setBusy(false);
    }
  };
  const act = () => {
    if (unread) void run(`/notifications/${String(n.id)}/read`, 'PATCH');
    const target = goTarget(actionTarget);
    if (target) navigate(target);
  };
  const ackPending = actionRequired && !ack;
  return (
    <div className={'com-notif' + (unread ? ' com-notif-unread' : '')}>
      <div className="com-notif-top">
        <span className="com-notif-title">{String(pick(n, 'title') ?? 'Notification')}</span>
        {prioBadge(pick(n, 'priority'))}
      </div>
      {pick(n, 'body') ? <p className="com-notif-body">{String(pick(n, 'body'))}</p> : null}
      <div className="com-notif-meta">
        <span>{fmtDate(pick(n, 'createdAt', 'created_at'))}</span>
        {pick(n, 'type') ? <span>{titleCase(String(pick(n, 'type')))}</span> : null}
        {actionRequired ? <span className="com-chip-required">Action required</span> : null}
      </div>
      {Boolean(actionLabel || actionTarget) && (
        <div className="com-notif-actions">
          {actionLabel ? <button className="btn btn-sm" onClick={act}>{actionLabel}</button> : null}
          {ackPending ? (
            <button className="btn btn-sm btn-ghost" onClick={() => void run(`/notifications/${String(n.id)}/acknowledge`, 'PATCH')}>Acknowledge</button>
          ) : null}
          {showRead && unread ? (
            <button className="btn btn-sm btn-ghost" onClick={() => void run(`/notifications/${String(n.id)}/read`, 'PATCH')}>Mark read</button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CommandCenter() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [alerts, setAlerts] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [cmd, ntf] = await Promise.all([
        api<{ data: Rec }>('/api/ops/communication/command'),
        api<{ data: { rows: Rec[] } }>('/api/ops/communication/notifications?pageSize=8&unread=true'),
      ]);
      setData(cmd.data);
      setAlerts(ntf.data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Command center failed');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading command center…" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const cards: { label: string; value: number; href: string; icon: string }[] = [
    { label: 'Urgent notifications', value: Number(kpis.urgentNotifications ?? 0), href: '/communication/notifications', icon: '\u26A0' },
    { label: 'Unread messages', value: Number(kpis.unreadMessages ?? 0), href: '/communication/messages', icon: '\u{1F4AC}' },
    { label: 'Active conversations', value: Number(kpis.activeConversations ?? 0), href: '/communication/messages', icon: '\u{1F465}' },
    { label: 'Pending approvals', value: Number(kpis.pendingApprovals ?? 0), href: '/approvals', icon: '\u2705' },
    { label: 'Pending deliveries', value: Number(kpis.pendingDeliveries ?? 0), href: '/communication/deliveries', icon: '\u{1F4E8}' },
  ];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'Factory Manager';
  const quick: { label: string; href: string; perm?: string; desc: string }[] = [
    { label: 'Start a conversation', href: '/communication/messages', perm: 'communication.messages.send', desc: 'Chat with the team around a job' },
    { label: 'Compose email', href: '/communication/email', perm: 'communication.emails.send', desc: 'Send from a template or from scratch' },
    { label: 'Publish announcement', href: '/communication/announcements', perm: 'communication.announcements.create', desc: 'Reach the whole factory' },
    { label: 'Review approvals', href: '/approvals', desc: 'Clear your decision queue' },
    { label: 'Open My Work', href: '/work', desc: 'Tasks, approvals and action items' },
  ].filter((q) => !q.perm || can(user, q.perm));
  return (
    <div className="page">
      <ComHead
        title={`${greet}, ${name}`}
        subtitle="HOPE DESIGN communication center — emails, messages, notifications and approvals in one place."
      />
      <ComTabs active="center" />
      <div className="kpi-grid">
        {cards.map((k) => (
          <button key={k.label} className="kpi-card" onClick={() => navigate(k.href)}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
            <span className="kpi-sub" aria-hidden>{k.icon} Open center</span>
          </button>
        ))}
      </div>
      <div className="grid-2">
        <section className="card card-pad">
          <div className="card-head">
            <h3>Priority alerts</h3>
            <span className="muted">{alerts.length} unread</span>
          </div>
          {alerts.length === 0 ? (
            <div className="empty-state">
              <h3>You're all caught up</h3>
              <p>No unread notifications right now.</p>
            </div>
          ) : (
            <div className="com-list">
              {alerts.map((n) => <NotifRow key={String(n.id)} n={n} onChanged={load} />)}
            </div>
          )}
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Quick actions</h3></div>
          <div className="stack">
            {quick.map((q) => (
              <button key={q.label} className="com-quick" onClick={() => navigate(q.href)}>
                <span className="com-quick-label">{q.label}</span>
                <span className="muted">{q.desc}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function bucketNotifs(rows: Rec[]): { now: Rec[]; today: Rec[]; later: Rec[]; info: Rec[] } {
  const now: Rec[] = [];
  const today: Rec[] = [];
  const later: Rec[] = [];
  const info: Rec[] = [];
  for (const n of rows) {
    const p = String(n.priority ?? '').toUpperCase();
    const actionRequired = !!n.actionRequired;
    if (p === 'CRITICAL' || p === 'URGENT') now.push(n);
    else if (p === 'HIGH' || actionRequired) today.push(n);
    else if (p === 'LOW') info.push(n);
    else later.push(n);
  }
  return { now, today, later, info };
}

function ComWorkView() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Rec | null>(null);
  const [notifs, setNotifs] = useState<Rec[]>([]);
  const [work, setWork] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [s, n, w] = await Promise.all([
        api<{ data: Rec }>('/api/ops/communication/summary'),
        api<{ data: { rows: Rec[] } }>('/api/ops/communication/notifications?pageSize=50&unread=true'),
        api<{ data: Rec }>('/api/dashboard/my-work').catch(() => null),
      ]);
      setSummary(s.data);
      setNotifs(n.data.rows ?? []);
      setWork(w?.data ?? null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your work');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !summary) return <ErrorBanner error={error} />;
  if (!summary) return <PageLoader label="Building your action center…" />;
  const totals = (summary.totals ?? {}) as Rec;
  const counts = ((work?.counts ?? {}) as Rec) ?? {};
  const buckets = bucketNotifs(notifs);
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'there';
  const tiles: { label: string; value: number; href: string; icon: string }[] = [
    { label: 'Approvals', value: Number(counts.approvals ?? 0), href: '/inbox', icon: '\u{1F4C1}' },
    { label: 'Tasks', value: Number(counts.tasks ?? 0), href: '/work', icon: '\u2705' },
    { label: 'Unread notifications', value: Number(totals.unreadNotifications ?? 0), href: '/communication/notifications', icon: '\u{1F514}' },
    { label: 'Urgent', value: Number(totals.urgentNotifications ?? 0), href: '/communication/notifications', icon: '\u26A0' },
    { label: 'Messages', value: Number(totals.messages ?? 0), href: '/communication/messages', icon: '\u{1F4AC}' },
  ];
  const bucketsView: { key: 'now' | 'today' | 'later' | 'info'; label: string; hint: string }[] = [
    { key: 'now', label: 'DO NOW', hint: 'Critical and urgent — decide immediately' },
    { key: 'today', label: 'DO TODAY', hint: 'High priority and action required' },
    { key: 'later', label: 'UPCOMING', hint: 'Normal priority items' },
    { key: 'info', label: 'INFORMATION', hint: 'Low priority updates' },
  ];
  return (
    <div className="page">
      <ComHead title={`What needs you, ${name.split(' ')[0]}`} subtitle="Approvals, tasks, messages and urgent alerts — your personal action center." />
      <ComTabs active="work" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="kpi-grid">
        {tiles.map((k) => (
          <button key={k.label} className="kpi-card" onClick={() => navigate(k.href)}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
            <span className="kpi-sub" aria-hidden>{k.icon} Open</span>
          </button>
        ))}
      </div>
      <div className="com-work-grid">
        {bucketsView.map((b) => (
          <section key={b.key} className="card card-pad com-work-bucket">
            <div className="card-head">
              <h3>{b.label}</h3>
              <span className="muted">{buckets[b.key].length}</span>
            </div>
            <p className="com-work-hint">{b.hint}</p>
            {buckets[b.key].length === 0 ? (
              <div className="empty-state">
                <h3>All clear</h3>
                <p>Nothing in this bucket right now.</p>
              </div>
            ) : (
              <div className="com-list">
                {buckets[b.key].slice(0, 6).map((n) => <NotifRow key={String(n.id)} n={n} onChanged={() => void load()} showRead />)}
              </div>
            )}
            {buckets[b.key].length > 6 ? (
              <button className="btn btn-sm btn-ghost com-work-more" type="button" onClick={() => navigate('/communication/notifications')}>
                View all {buckets[b.key].length}
              </button>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function CommunicationAdmin() {
  const [summary, setSummary] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/ops/communication/summary');
      setSummary(r.data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load communication health');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !summary) return <ErrorBanner error={error} />;
  if (!summary) return <PageLoader label="Loading communication health…" />;
  const totals = (summary.totals ?? {}) as Rec;
  const deliveries = (summary.deliveries ?? {}) as Rec;
  const statusKeys = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'RETRYING', 'CANCELLED'];
  const toneFor = (s: string) =>
    s === 'FAILED' || s === 'BOUNCED' ? 'badge-critical'
    : s === 'RETRYING' ? 'badge-amber'
    : s === 'READ' || s === 'DELIVERED' ? 'badge-success'
    : 'badge-blue';
  const failed = Number(deliveries.FAILED ?? 0) + Number(deliveries.BOUNCED ?? 0);
  const health: { name: string; icon: string; note: string; tone: string }[] = [
    { name: 'Email', icon: '\u2709', note: `${Number(totals.emails ?? 0)} messages tracked`, tone: 'badge-success' },
    { name: 'Messaging', icon: '\u{1F4AC}', note: `${Number(totals.messages ?? 0)} messages sent`, tone: 'badge-success' },
    { name: 'Notifications', icon: '\u{1F514}', note: `${Number(totals.notifications ?? 0)} total · ${Number(totals.unreadNotifications ?? 0)} unread`, tone: 'badge-success' },
    { name: 'SMS / WhatsApp', icon: '\u{1F4F1}', note: failed > 0 ? `${failed} failed deliveries` : 'Operational', tone: failed > 0 ? 'badge-critical' : 'badge-success' },
  ];
  const tiles: { label: string; value: number; href: string; perm?: string }[] = [
    { label: 'Email templates', value: Number(totals.templates ?? 0), href: '/communication/templates', perm: 'communication.templates.view' },
    { label: 'Channels', value: Number(totals.channels ?? 0), href: '/communication/settings', perm: 'communication.settings.manage' },
    { label: 'Emails', value: Number(totals.emails ?? 0), href: '/communication/email', perm: 'communication.emails.view' },
    { label: 'Delivery failures', value: failed, href: '/communication/deliveries', perm: 'communication.delivery_logs.view', },
  ];
  return (
    <div className="page">
      <ComHead title="Communication health" subtitle="Delivery status, channel health and configuration at a glance." />
      <ComTabs active="admin" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="kpi-grid">
        {tiles.map((t) => (
          <button key={t.label} className="kpi-card" onClick={() => navigate(t.href)}>
            <span className="kpi-label">{t.label}</span>
            <span className="kpi-value">{t.value}</span>
            <span className="kpi-sub" aria-hidden>Open</span>
          </button>
        ))}
      </div>
      <div className="grid-2">
        <section className="card card-pad">
          <div className="card-head"><h3>Channels</h3><span className="muted">Health</span></div>
          <div className="com-health-list">
            {health.map((h) => (
              <div key={h.name} className="com-health-row">
                <span className="com-health-name">{h.icon} {h.name}</span>
                <span className={`badge ${h.tone}`}>
                  <span className="badge-icon" aria-hidden>{h.tone === 'badge-success' ? '✓' : '✕'}</span>
                  {h.tone === 'badge-success' ? 'OPERATIONAL' : 'ATTENTION'}
                </span>
                <span className="muted">{h.note}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Delivery queue</h3><span className="muted">By status</span></div>
          <div className="com-deliv-list">
            {statusKeys.map((s) => (
              <div key={s} className="com-deliv-row">
                <span className={`badge ${toneFor(s)}`}>{s}</span>
                <span className="com-deliv-count">{Number(deliveries[s] ?? 0)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function convoName(cv: Rec, peers: Map<number, Rec>, selfId: number): string {
  const title = pick<string>(cv, 'title');
  if (title && title.trim()) return title;
  const kind = String(pick(cv, 'kind') ?? '');
  const others = [...peers.entries()].filter(([id]) => id !== selfId).map(([, p]) => p);
  if (kind === 'DIRECT' && others.length > 0) return fullName(others[0]);
  if (others.length > 0) return others.slice(0, 3).map(fullName).join(', ');
  return kind === 'CHANNEL' ? 'Channel' : 'Conversation';
}

function convoAvatar(cv: Rec, peers: Map<number, Rec>, selfId: number): string {
  const title = pick<string>(cv, 'title');
  const words = (title && title.trim() ? title.trim() : convoName(cv, peers, selfId)).split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '#';
}

function PeoplePicker({ selected, onChange }: { selected: Rec[]; onChange: (p: Rec[]) => void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Rec[]>([]);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      if (!q.trim()) {
        setPeople([]);
        return;
      }
      api<{ data: Rec[] }>(`/api/ops/communication/people?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (live) setPeople(r.data ?? []); })
        .catch(() => { if (live) setPeople([]); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [q]);
  const toggle = (p: Rec) => {
    if (selected.some((s) => Number(s.id) === Number(p.id))) {
      onChange(selected.filter((s) => Number(s.id) !== Number(p.id)));
    } else {
      onChange([...selected, p]);
    }
  };
  return (
    <div className="com-picker">
      <div className="com-picker-chips">
        {selected.map((p) => (
          <button key={String(p.id)} className="chip chip-active" type="button" onClick={() => toggle(p)}>
            {fullName(p)} <span className="chip-x" aria-hidden>&times;</span>
          </button>
        ))}
        <input
          className="search-input"
          placeholder="Search people by name, username or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {q.trim() ? (
        <div className="com-picker-results">
          {people.length === 0 ? (
            <p className="muted">No matches</p>
          ) : (
            people.map((p) => (
              <button
                key={String(p.id)}
                className={'com-picker-row' + (selected.some((s) => Number(s.id) === Number(p.id)) ? ' com-picker-row-on' : '')}
                type="button"
                onClick={() => toggle(p)}
              >
                <span className="com-avatar com-avatar-sm">{avatarText(p)}</span>
                <span className="com-picker-name">
                  <span>{fullName(p)}</span>
                  <span className="muted">{[pick(p, 'jobTitle'), pick(p, 'departmentName')].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ComposeConvo({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [kind, setKind] = useState('DIRECT');
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState<Rec[]>([]);
  const [people, setPeople] = useState<Rec[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== 'CHANNEL') return;
    let live = true;
    api<{ data: Rec[] }>('/api/ops/communication/channels')
      .then((r) => { if (live) setChannels(r.data ?? []); })
      .catch(() => { if (live) setChannels([]); });
    return () => { live = false; };
  }, [kind]);
  const save = async () => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const payload: Rec = { kind };
      if (kind === 'DIRECT') {
        if (people.length !== 1) throw new Error('Select exactly one person for a direct message');
        payload.userIds = people.map((p) => Number(p.id));
      } else if (kind === 'GROUP') {
        if (!title.trim()) throw new Error('Give the conversation a name');
        payload.title = title.trim();
        payload.userIds = people.map((p) => Number(p.id));
      } else {
        if (!channelId) throw new Error('Choose a channel');
        payload.channelId = Number(channelId);
      }
      const r = await api<{ data: Rec }>('/api/ops/communication/conversations', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onCreated(Number((r.data as Rec).id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the conversation');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Start a conversation"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Creating…' : 'Create conversation'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <div className="field">
          <label>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="DIRECT">Direct message</option>
            <option value="GROUP">Group message</option>
            <option value="CHANNEL">Channel</option>
          </select>
        </div>
        {kind === 'CHANNEL' ? (
          <div className="field">
            <label>Channel</label>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Select a channel…</option>
              {channels.map((ch) => (
                <option key={String(ch.id)} value={String(ch.id)}>
                  {String(pick(ch, 'name') ?? '')}{ch.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {kind === 'GROUP' ? (
          <div className="field">
            <label>Name</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Production team" />
          </div>
        ) : null}
      </div>
      {kind !== 'CHANNEL' ? (
        <div className="field">
          <label>{kind === 'DIRECT' ? 'Person' : 'Members'}</label>
          <PeoplePicker selected={people} onChange={setPeople} />
        </div>
      ) : null}
    </Modal>
  );
}

function ConversationRow({ cv, peers, active, onOpen }: { cv: Rec; peers: Map<number, Rec>; active: boolean; onOpen: () => void }) {
  const { user } = useAuth();
  const selfId = Number(user?.id ?? 0);
  const unread = Number(pick(cv, 'unreadCount', 'unread_count') ?? 0);
  const last = String(pick(cv, 'lastMessage', 'last_message') ?? '');
  return (
    <button className={'com-conv' + (active ? ' com-conv-active' : '')} type="button" onClick={onOpen}>
      <span className="com-avatar">{convoAvatar(cv, peers, selfId)}</span>
      <span className="com-conv-main">
        <span className="com-conv-top">
          <span className="com-conv-name">{convoName(cv, peers, selfId)}</span>
          <span className="com-conv-date">{fmtDate(pick(cv, 'lastMessageAt', 'last_message_at', 'updatedAt', 'updated_at'))}</span>
        </span>
        <span className="com-conv-last">{last ? trunc(last, 70) : 'No messages yet'}</span>
      </span>
      {unread > 0 ? <span className="com-unread">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
  );
}

function MessageRow({ m, mine }: { m: Rec; mine: boolean }) {
  const reactions = Array.isArray(m.reactions) ? (m.reactions as unknown[]) : [];
  return (
    <div className={'com-msg' + (mine ? ' com-msg-mine' : '')}>
      {!mine ? <span className="com-avatar com-avatar-sm">{avatarText(m)}</span> : null}
      <div className="com-msg-bubble">
        {!mine ? <span className="com-msg-name">{fullName(m)}</span> : null}
        <span className="com-msg-body">{String(m.body ?? '')}</span>
        <span className="com-msg-meta">
          <span>{fmtDate(m.createdAt ?? m.created_at)}</span>
          {reactions.length > 0 ? <span aria-label="reactions">{reactions.map((r) => String(r)).join(' ')}</span> : null}
        </span>
      </div>
    </div>
  );
}

function ThreadPane({ convId, onBack, onChanged }: { convId: number; onBack: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const selfId = Number(user?.id ?? 0);
  const [conv, setConv] = useState<Rec | null>(null);
  const [msgs, setMsgs] = useState<Rec[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [mentionQ, setMentionQ] = useState('');
  const [people, setPeople] = useState<Rec[]>([]);
  const [showPeople, setShowPeople] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionTimer = useRef<number | null>(null);
  const load = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([
        api<{ data: Rec }>(`/api/ops/communication/conversations/${convId}`),
        api<{ data: Rec[] }>(`/api/ops/communication/conversations/${convId}/messages?pageSize=100`),
      ]);
      setConv(c.data);
      setMsgs(m.data ?? []);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load conversation');
    }
  }, [convId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void api(`/api/ops/communication/conversations/${convId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [convId, msgs.length]);
  useEffect(() => {
    const t = window.setInterval(() => { void load(); }, 8000);
    return () => window.clearInterval(t);
  }, [load]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs]);
  const send = async () => {
    const body = input.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api(`/api/ops/communication/conversations/${convId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setInput('');
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send message');
    } finally {
      setBusy(false);
    }
  };
  const searchPeople = useCallback(async (q: string) => {
    try {
      const r = await api<{ data: Rec[] }>(`/api/ops/communication/people?q=${encodeURIComponent(q)}`);
      setPeople(r.data ?? []);
    } catch {
      setPeople([]);
    }
  }, []);
  const onInput = (v: string) => {
    setInput(v);
    const at = v.lastIndexOf('@');
    if (at >= 0) {
      const q = v.slice(at + 1).trim();
      setMentionQ(q);
      setShowPeople(true);
      if (mentionTimer.current) window.clearTimeout(mentionTimer.current);
      mentionTimer.current = window.setTimeout(() => { void searchPeople(q); }, 200);
    } else {
      setShowPeople(false);
      if (mentionTimer.current) { window.clearTimeout(mentionTimer.current); mentionTimer.current = null; }
    }
  };
  const pickMention = (p: Rec) => {
    const at = input.lastIndexOf('@');
    const before = at >= 0 ? input.slice(0, at) : input;
    const after = at >= 0 ? input.slice(at + 1 + mentionQ.length) : '';
    setInput(`${before}@${fullName(p)} ${after}`.trim());
    setShowPeople(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };
  useEffect(() => () => { if (mentionTimer.current) window.clearTimeout(mentionTimer.current); }, []);
  const viewMsgs = [...msgs].reverse();
  return (
    <div className="com-thread">
      <div className="com-thread-head">
        <button className="btn btn-sm btn-ghost" type="button" onClick={onBack}>‹ Back</button>
        <div>
          <h3>{conv ? convoName(conv, new Map(), selfId) : 'Conversation'}</h3>
          <span className="muted">{conv ? String(conv.kind ?? '') : ''}</span>
        </div>
      </div>
      {err ? <ErrorBanner error={err} /> : null}
      <div className="com-thread-msgs">
        {viewMsgs.length === 0 ? (
          <div className="empty-state">
            <h3>No messages yet</h3>
            <p>Say hello to start the conversation.</p>
          </div>
        ) : (
          viewMsgs.map((m) => (
            <MessageRow key={String(m.id)} m={m} mine={Number(m.senderId ?? m.sender_id) === selfId} />
          ))
        )}
        <div ref={endRef} />
      </div>
      <div className="com-thread-input">
        {showPeople && people.length > 0 ? (
          <div className="com-mentions" role="listbox" aria-label="Mention someone">
            {people.slice(0, 6).map((p) => (
              <button key={String(p.id)} type="button" className="com-mention" role="option" onClick={() => pickMention(p)}>
                <span className="com-avatar com-avatar-sm">{avatarText(p)}</span>
                <span className="com-picker-name">
                  <span>{fullName(p)}</span>
                  <span className="muted">{String(pick(p, 'jobTitle', 'job_title', 'departmentName', 'department_name') ?? '')}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Type a message… (@ to mention, Enter to send)"
        />
        <button className="btn btn-primary" type="button" onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

function MessagesView({ initialId }: { initialId: string | null }) {
  const { user } = useAuth();
  const [convos, setConvos] = useState<Rec[]>([]);
  const [peers, setPeers] = useState<Map<number, Rec>>(new Map());
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<Rec[]>([]);
  const [activeId, setActiveId] = useState<number | null>(initialId ? Number(initialId) : null);
  const [compose, setCompose] = useState(false);
  const [convDetail, setConvDetail] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const loadConvos = useCallback(async () => {
    try {
      const qs = kind ? `?kind=${kind}` : '';
      const r = await api<{ data: Rec[] }>(`/api/ops/communication/conversations${qs}`);
      const rows = r.data ?? [];
      setConvos(rows);
      const unnamed = rows.filter((cv) => !pick<string>(cv, 'title')).slice(0, 10);
      const m = new Map<number, Rec>();
      await Promise.all(unnamed.map(async (cv) => {
        try {
          const d = await api<{ data: Rec }>(`/api/ops/communication/conversations/${String(cv.id)}`);
          const members = Array.isArray(d.data.members) ? (d.data.members as Rec[]) : [];
          for (const mb of members) m.set(Number(mb.userId ?? mb.user_id), mb);
        } catch {
          /* skip untitled conversation */
        }
      }));
      setPeers(m);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load conversations');
    }
  }, [kind]);
  useEffect(() => { void loadConvos(); }, [loadConvos]);
  useEffect(() => {
    if (!activeId) {
      setConvDetail(null);
      return;
    }
    let live = true;
    api<{ data: Rec }>(`/api/ops/communication/conversations/${activeId}`)
      .then((r) => { if (live) setConvDetail(r.data); })
      .catch(() => { if (live) setConvDetail(null); });
    return () => { live = false; };
  }, [activeId]);
  useEffect(() => {
    if (!search.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      api<{ data: Rec[] }>(`/api/ops/communication/messages/search?q=${encodeURIComponent(search.trim())}`)
        .then((r) => { if (live) setHits(r.data ?? []); })
        .catch(() => { if (live) setHits([]); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [search]);
  const openId = (id: number) => {
    setActiveId(id);
    navigate(`/communication/messages/${id}`);
  };
  return (
    <div className="page">
      <ComHead
        title="Messages"
        subtitle="Chat with your team around jobs, machines and decisions."
        actions={
          can(user, 'communication.messages.send') ? (
            <button className="btn btn-primary" type="button" onClick={() => setCompose(true)}>+ Start conversation</button>
          ) : undefined
        }
      />
      <ComTabs active="messages" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="com-msg-layout">
        <aside className="com-conv-pane">
          <div className="com-conv-tools">
            <input className="search-input" placeholder="Search messages…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter conversations">
              <option value="">All</option>
              <option value="DIRECT">Direct</option>
              <option value="GROUP">Groups</option>
              <option value="CHANNEL">Channels</option>
            </select>
          </div>
          {search.trim() ? (
            <div className="stack">
              {hits.length === 0 ? (
                <p className="muted">No message matches</p>
              ) : (
                hits.map((h) => (
                  <button key={String(h.id)} className="com-search-hit" type="button" onClick={() => openId(Number(h.conversationId ?? h.conversation_id))}>
                    <span className="com-conv-name">{String(pick(h, 'conversationTitle', 'conversation_title') ?? 'Message')}</span>
                    <span className="muted">{trunc(pick(h, 'body'), 90)}</span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="com-conv-list">
              {convos.length === 0 ? (
                <div className="empty-state">
                  <h3>No conversations yet</h3>
                  <p>Start a direct message or a group chat to get going.</p>
                </div>
              ) : (
                convos.map((cv) => (
                  <ConversationRow key={String(cv.id)} cv={cv} peers={peers} active={Number(cv.id) === activeId} onOpen={() => openId(Number(cv.id))} />
                ))
              )}
            </div>
          )}
        </aside>
        <section className="com-thread-pane">
          {activeId ? (
            <ThreadPane convId={activeId} onBack={() => { setActiveId(null); navigate('/communication/messages'); }} onChanged={() => void loadConvos()} />
          ) : (
            <div className="empty-state">
              <h3>Select a conversation</h3>
              <p>Pick a chat from the list, or start a new one.</p>
            </div>
          )}
        </section>
        <aside className="com-context-pane">
          {convDetail ? (
            <div className="com-context">
              <div className="com-context-head">
                <span className="muted">{convDetail.kind === 'RECORD' ? 'Related record' : 'Conversation'}</span>
              </div>
              <h3>{String(convDetail.title ?? 'Untitled')}</h3>
              {convDetail.kind ? <p><Badge value={convDetail.kind} /></p> : null}
              {convDetail.entityType ? <p className="com-context-type">{String(convDetail.entityType)}</p> : null}
              {convDetail.entityId ? <p className="cell-mono">{String(convDetail.entityId)}</p> : null}
              {Array.isArray(convDetail.members) ? (
                <p className="muted">{(convDetail.members as Rec[]).length} member(s)</p>
              ) : null}
              {convDetail.entityType && Number(convDetail.entityId) ? (
                <button className="btn btn-primary" type="button" onClick={() => {
                  const target = pathForEntity(String(convDetail.entityType), Number(convDetail.entityId));
                  if (target && !target.startsWith('/records//')) navigate(target);
                }}>Open record</button>
              ) : null}
            </div>
          ) : (
            <div className="com-context com-context-empty">
              <span className="muted">Select a conversation to see its context.</span>
            </div>
          )}
        </aside>
      </div>
      {compose ? (
        <ComposeConvo onClose={() => setCompose(false)} onCreated={(id) => { setCompose(false); openId(id); }} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function NotificationsView({ archived }: { archived?: boolean }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [prio, setPrio] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(!archived);
  const [error, setError] = useState('');
  const pageSize = 20;
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));
      if (prio) qs.set('priority', prio);
      if (onlyUnread) qs.set('unread', 'true');
      if (archived) qs.set('archived', 'true');
      const r = await api<{ data: { rows: Rec[]; pagination: { page: number; pageSize: number; total: number } } }>(
        `/api/ops/communication/notifications?${qs.toString()}`
      );
      setRows(r.data.rows ?? []);
      setTotal(r.data.pagination?.total ?? 0);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load notifications');
    }
  }, [page, prio, onlyUnread, pageSize, archived]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setPage(1);
    setOnlyUnread(!archived);
    setPrio('');
  }, [archived]);
  const markAll = async () => {
    try {
      await api('/api/ops/communication/notifications/read-all', { method: 'POST' });
      void load();
    } catch {
      /* quiet */
    }
  };
  return (
    <div className="page">
      <ComHead
        title={archived ? 'Archived' : 'Notifications'}
        subtitle={archived ? 'Items you have archived for the record.' : 'Your attention list — approvals, alerts and actions.'}
        actions={archived ? undefined : <button className="btn btn-ghost" type="button" onClick={() => void markAll()}>Mark all read</button>}
      />
      <ComTabs active={archived ? 'archive' : 'notifications'} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="filter-bar">
        <select value={prio} onChange={(e) => { setPrio(e.target.value); setPage(1); }} aria-label="Priority filter">
          <option value="">All priorities</option>
          <option value="CRITICAL">Critical</option>
          <option value="URGENT">Urgent</option>
          <option value="HIGH">High</option>
          <option value="NORMAL">Normal</option>
          <option value="LOW">Low</option>
        </select>
        {!archived ? (
          <label className="filter-chip">
            <input type="checkbox" checked={onlyUnread} onChange={(e) => { setOnlyUnread(e.target.checked); setPage(1); }} />
            Unread only
          </label>
        ) : null}
      </div>
      <div className="com-list">
        {rows.length === 0 ? (
          <div className="empty-state">
            <h3>{archived ? 'No archived notifications' : 'All clear'}</h3>
            <p>{archived ? 'Archived notifications will appear here.' : 'No notifications match this view.'}</p>
          </div>
        ) : (
          rows.map((n) => <NotifRow key={String(n.id)} n={n} onChanged={() => void load()} showRead />)
        )}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
function ComposeEmail({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  const [templates, setTemplates] = useState<Rec[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/communication/templates')
      .then((r) => setTemplates(r.data ?? []))
      .catch(() => setTemplates([]));
  }, []);
  const applyTemplate = (code: string) => {
    setTemplateCode(code);
    const t = templates.find((x) => String(x.code) === code);
    if (t) {
      setSubject(String(pick(t, 'subject') ?? ''));
      setBody(String(pick(t, 'body') ?? ''));
    }
  };
  const split = (s: string) => s.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
  const save = async (send: boolean) => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const payload: Rec = {
        subject: subject.trim(),
        body,
        to: split(to),
        cc: split(cc),
        bcc: split(bcc),
        status: send ? 'SENT' : 'DRAFT',
        templateCode: templateCode || undefined,
        entityType: entityType.trim() || undefined,
        entityId: entityId.trim() || undefined,
      };
      if (scheduledAt) payload.scheduledAt = scheduledAt;
      const r = await api<{ data: Rec }>('/api/ops/communication/emails', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (send) await api(`/api/ops/communication/emails/${String((r.data as Rec).id)}/send`, { method: 'POST' });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save email');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Compose email"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={() => void save(false)} disabled={busy}>Save draft</button>
          <button className="btn btn-success" type="button" onClick={() => void save(true)} disabled={busy}>Send</button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <div className="field">
          <label>Template</label>
          <select value={templateCode} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">Start from scratch</option>
            {templates.map((t) => (
              <option key={String(t.id)} value={String(t.code)}>{String(t.name ?? t.code)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" />
        </div>
        <div className="field">
          <label>To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="one@example.com, two@example.com" />
        </div>
        <div className="field">
          <label>CC</label>
          <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" />
        </div>
        <div className="field">
          <label>BCC</label>
          <input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="optional" />
        </div>
        <div className="field">
          <label>Related record type</label>
          <input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. sales.orders, procurement.orders" />
        </div>
        <div className="field">
          <label>Related record ID</label>
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Record number" />
        </div>
        <div className="field">
          <label>Schedule send (optional)</label>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </div>
      </div>
      {entityType.trim() && entityId.trim() ? (
        <div className="com-mail-related">
          <span className="muted com-mail-related-label">Related record</span>
          <div className="com-mail-related-card">
            <span className="com-mail-related-type">{entityType.trim()}</span>
            <span className="cell-mono">{entityId.trim()}</span>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => {
              const target = pathForEntity(entityType.trim(), Number(entityId.trim()));
              if (target && !target.startsWith('/records//')) navigate(target);
            }}>Open</button>
          </div>
        </div>
      ) : null}
      <div className="field">
        <label>Message</label>
        <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" />
      </div>
    </Modal>
  );
}

function EmailDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [email, setEmail] = useState<Rec | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ data: Rec }>(`/api/ops/communication/emails/${id}`)
      .then((r) => setEmail(r.data))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load email'));
  }, [id]);
  if (err) return <Modal title="Email" onClose={onClose}><ErrorBanner error={err} /></Modal>;
  if (!email) return <Modal title="Email" onClose={onClose}><PageLoader label="Loading email…" /></Modal>;
  const recips = Array.isArray(email.recipients) ? (email.recipients as Rec[]) : [];
  const list = (kind: string) => recips.filter((r) => String(r.kind) === kind).map((r) => String(r.email)).join(', ');
  return (
    <Modal title={String(email.subject ?? 'Email')} onClose={onClose} wide>
      <div className="stack">
        <div className="com-mail-meta">
          <span><b>Status</b> <Badge value={email.status} /></span>
          <span><b>Direction</b> {String(email.direction ?? 'OUT')}</span>
          <span><b>Created</b> {fmtDate(email.createdAt ?? email.created_at)}</span>
          <span><b>Recipients</b> {recips.length}</span>
        </div>
        {list('TO') ? <p><b>To:</b> {list('TO')}</p> : null}
        {list('CC') ? <p><b>CC:</b> {list('CC')}</p> : null}
        {list('BCC') ? <p><b>BCC:</b> {list('BCC')}</p> : null}
        <div className="com-mail-body">{String(email.body ?? '')}</div>
      </div>
    </Modal>
  );
}

function EmailView({ preset }: { preset?: 'inbox' | 'sent' | 'drafts' }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [direction, setDirection] = useState(preset === 'sent' ? 'OUT' : '');
  const [status, setStatus] = useState(preset === 'sent' ? 'SENT' : preset === 'drafts' ? 'DRAFT' : '');
  const [compose, setCompose] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const pageSize = 20;
  useEffect(() => {
    setPage(1);
    setDirection(preset === 'sent' ? 'OUT' : '');
    setStatus(preset === 'sent' ? 'SENT' : preset === 'drafts' ? 'DRAFT' : '');
  }, [preset]);
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));
      if (direction) qs.set('direction', direction);
      if (status) qs.set('status', status);
      const r = await api<{ data: { rows: Rec[]; pagination: { page: number; pageSize: number; total: number } } }>(
        `/api/ops/communication/emails?${qs.toString()}`
      );
      setRows(r.data.rows ?? []);
      setTotal(r.data.pagination?.total ?? 0);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load emails');
    }
  }, [page, direction, status, pageSize]);
  useEffect(() => { void load(); }, [load]);
  const title = preset === 'sent' ? 'Sent' : preset === 'drafts' ? 'Drafts' : 'Inbox';
  return (
    <div className="page">
      <ComHead
        title={title}
        subtitle={preset === 'sent' ? 'Emails you have sent.' : preset === 'drafts' ? 'Saved drafts waiting to be sent.' : 'Compose, send and track enterprise email.'}
        actions={
          can(user, 'communication.emails.send') ? (
            <button className="btn btn-primary" type="button" onClick={() => setCompose(true)}>+ Compose email</button>
          ) : undefined
        }
      />
      <ComTabs active={preset ?? 'email'} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="filter-bar">
        <select value={direction} onChange={(e) => { setDirection(e.target.value); setPage(1); }} aria-label="Direction filter">
          <option value="">All directions</option>
          <option value="OUT">Outbound</option>
          <option value="IN">Inbound</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SENT">Sent</option>
          <option value="SCHEDULED">Scheduled</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>
      <div className="card card-pad">
        <table className="data">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    <h3>No emails yet</h3>
                    <p>Compose your first message or use a template.</p>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((e) => (
                <tr key={String(e.id)} className="row-click" onClick={() => setDetailId(Number(e.id))}>
                  <td>
                    <span className="cell-main">{String(e.subject ?? '')}</span>
                    <span className="cell-sub muted">{String(e.templateCode ?? e.creatorName ?? '')}</span>
                  </td>
                  <td><Badge value={e.status} /></td>
                  <td>{String(e.recipientCount ?? 0)}</td>
                  <td className="cell-mono">{fmtDate(e.createdAt ?? e.created_at)}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" type="button" onClick={(ev) => { ev.stopPropagation(); setDetailId(Number(e.id)); }}>View</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
      </div>
      {compose ? <ComposeEmail onClose={() => setCompose(false)} onSaved={() => void load()} /> : null}
      {detailId ? <EmailDetail id={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}

const ANNOUNCE_ROLES: { code: string; label: string }[] = [
  { code: 'managing_director', label: 'Managing Director' },
  { code: 'operations_director', label: 'Operations Director' },
  { code: 'production_manager', label: 'Production Manager' },
  { code: 'production_planner', label: 'Production Planner' },
  { code: 'production_supervisor', label: 'Shift Supervisor' },
  { code: 'quality_manager', label: 'Quality Manager' },
  { code: 'quality_inspector', label: 'Quality Inspector' },
  { code: 'warehouse_manager', label: 'Warehouse Manager' },
  { code: 'storekeeper', label: 'Storekeeper' },
  { code: 'maintenance_manager', label: 'Maintenance Manager' },
  { code: 'finance_manager', label: 'Finance Manager' },
  { code: 'hr_manager', label: 'HR Manager' },
  { code: 'sales_manager', label: 'Sales Manager' },
];

function PublishAnnouncement({ onClose, onPublished }: { onClose: () => void; onPublished: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('GENERAL');
  const [priority, setPriority] = useState('NORMAL');
  const [requiresAck, setRequiresAck] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [roles, setRoles] = useState<Rec[]>([]);
  const [people, setPeople] = useState<Rec[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toggleRole = (code: string) => {
    setRoles((prev) => (prev.some((r) => String(r.code) === code) ? prev.filter((r) => String(r.code) !== code) : [...prev, { code }]));
  };
  const save = async () => {
    if (busy) return;
    setErr('');
    if (!title.trim() || !body.trim()) {
      setErr('Title and message are required');
      return;
    }
    setBusy(true);
    try {
      await api('/api/ops/communication/announcements', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          category,
          priority,
          audience: {
            roles: roles.map((r) => String(r.code)),
            userIds: people.map((p) => Number(p.id)),
          },
          requiresAck,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      onPublished();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not publish the announcement');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Publish announcement"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <div className="field">
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Scheduled factory maintenance" />
        </div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {['GENERAL', 'OPERATIONS', 'MAINTENANCE', 'SAFETY', 'HR', 'FINANCE', 'EMERGENCY'].map((v) => (
              <option key={v} value={v}>{titleCase(v)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Message</label>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What does the factory need to know?" />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL'].map((v) => (
              <option key={v} value={v}>{titleCase(v)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Expires</label>
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Audience — roles</label>
        <div className="com-picker-chips">
          {ANNOUNCE_ROLES.map((r) => (
            <button
              key={r.code}
              type="button"
              className={'chip' + (roles.some((x) => String(x.code) === r.code) ? ' chip-active' : '')}
              onClick={() => toggleRole(r.code)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="muted">Leave empty to reach all active staff.</p>
      </div>
      <div className="field">
        <label>Audience — specific people</label>
        <PeoplePicker selected={people} onChange={setPeople} />
      </div>
      <label className="check-line">
        <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
        Require acknowledgement from readers
      </label>
    </Modal>
  );
}

function AnnouncementsView() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [publish, setPublish] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: { rows: Rec[]; pagination: { page: number; pageSize: number; total: number } } }>(
        `/api/ops/communication/announcements?page=${page}&pageSize=${pageSize}`
      );
      setRows(r.data.rows ?? []);
      setTotal(r.data.pagination?.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load announcements');
    }
  }, [page, pageSize]);
  useEffect(() => { void load(); }, [load]);
  const mark = async (id: number, acknowledge: boolean) => {
    try {
      await api(`/api/ops/communication/announcements/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ acknowledge }),
      });
      void load();
    } catch {
      /* background action stays quiet */
    }
  };
  const audienceSummary = (a: Rec): string => {
    const aud = (pick(a, 'audience') ?? {}) as Rec;
    const rl = Array.isArray(aud.roles) ? aud.roles : [];
    const us = Array.isArray(aud.userIds) ? aud.userIds : [];
    if (rl.length === 0 && us.length === 0) return 'All staff';
    const labels = rl
      .map((rc) => ANNOUNCE_ROLES.find((r) => r.code === String(rc))?.label)
      .filter(Boolean);
    const extra = us.length > 0 ? `${us.length} individual${us.length > 1 ? 's' : ''}` : '';
    return [labels.join(', '), extra].filter(Boolean).join(' + ') || 'Selected staff';
  };
  return (
    <div className="page">
      <ComHead
        title="Announcements"
        subtitle="Company-wide notices with read and acknowledgement tracking."
        actions={
          <button className="btn btn-primary" onClick={() => setPublish(true)}>+ Publish</button>
        }
      />
      <ComTabs active="announcements" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="stack">
        {rows.length === 0 && !error ? (
          <div className="card card-pad empty-state">
            <h3>No announcements</h3>
            <p>Publish a company-wide notice to keep the factory informed.</p>
            <button className="btn btn-primary" onClick={() => setPublish(true)}>Publish announcement</button>
          </div>
        ) : (
          rows.map((a) => {
            const requiresAck = !!pick(a, 'requiresAck', 'requires_ack');
            const viewed = !!pick(a, 'viewed');
            const acknowledged = !!pick(a, 'acknowledged');
            const pendingAck = requiresAck && !acknowledged;
            return (
              <article key={String(a.id)} className={'card card-pad com-notif' + (viewed ? '' : ' com-notif-unread')}>
                <div className="com-notif-top">
                  <span className="com-notif-title">{String(pick(a, 'title') ?? 'Announcement')}</span>
                  <span className="stack-row">
                    <Badge value={pick(a, 'category')} />
                    {prioBadge(pick(a, 'priority'))}
                  </span>
                </div>
                <p className="com-notif-body">{String(pick(a, 'body') ?? '')}</p>
                <div className="com-notif-meta">
                  <span>{fmtDate(pick(a, 'publishedAt', 'published_at'))}</span>
                  <span>{String(pick(a, 'publisherName', 'publisher_name') ?? '')}</span>
                  <span>{audienceSummary(a)}</span>
                  {pendingAck ? <span className="com-chip-required">Acknowledgement required</span> : null}
                </div>
                <div className="com-notif-actions">
                  {!viewed ? (
                    <button className="btn btn-sm" onClick={() => void mark(Number(a.id), false)}>Mark as read</button>
                  ) : null}
                  {pendingAck ? (
                    <button className="btn btn-sm btn-primary" onClick={() => void mark(Number(a.id), true)}>Acknowledge</button>
                  ) : null}
                  {viewed ? <span className="muted">✓ Read{acknowledged ? ' and acknowledged' : ''}</span> : null}
                </div>
              </article>
            );
          })
        )}
        {rows.length > 0 ? <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /> : null}
      </div>
      {publish ? <PublishAnnouncement onClose={() => setPublish(false)} onPublished={() => void load()} /> : null}
    </div>
  );
}

function TemplateModal({ initial, onClose, onSaved }: { initial: Rec | null; onClose: () => void; onSaved: () => void }) {
  const init: Rec = initial ?? {};
  const [code, setCode] = useState(String(pick(init, 'code') ?? ''));
  const [name, setName] = useState(String(pick(init, 'name') ?? ''));
  const [category, setCategory] = useState(String(pick(init, 'category') ?? 'GENERAL'));
  const [subject, setSubject] = useState(String(pick(init, 'subject') ?? ''));
  const [body, setBody] = useState(String(pick(init, 'body') ?? ''));
  const [isActive, setIsActive] = useState(pick(init, 'isActive', 'is_active') !== false);
  const [vars, setVars] = useState(
    (Array.isArray(pick(init, 'variables')) ? (pick(init, 'variables') as unknown[]) : []).map(String).join(', ')
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const variableList = () => vars.split(',').map((v) => v.trim()).filter(Boolean);
  const save = async () => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      await api('/api/ops/communication/templates', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          category,
          subject,
          body,
          variables: variableList(),
          isActive,
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the template');
    } finally {
      setBusy(false);
    }
  };
  const runPreview = async () => {
    setErr('');
    try {
      const r = await api<{ data: { subject: string; body: string } }>('/api/ops/communication/templates/preview', {
        method: 'POST',
        body: JSON.stringify({ subject, body, variables: {} }),
      });
      setPreview(r.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed');
    }
  };
  return (
    <Modal
      title={initial ? 'Edit template' : 'New template'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void runPreview()}>Preview</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <div className="field">
          <label>Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. INVOICE_REMINDER" disabled={!!initial} />
        </div>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payment reminder" />
        </div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {['GENERAL', 'SALES', 'PROCUREMENT', 'FINANCE', 'HR', 'OPERATIONS', 'SYSTEM'].map((v) => (
              <option key={v} value={v}>{titleCase(v)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Variables (comma separated)</label>
          <input value={vars} onChange={(e) => setVars(e.target.value)} placeholder="CUSTOMER_NAME, AMOUNT, DUE_DATE" />
        </div>
      </div>
      <div className="field">
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Invoice {{INVOICE_NUMBER}} is due" />
      </div>
      <div className="field">
        <label>Body</label>
        <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Dear {{CUSTOMER_NAME}},…" />
      </div>
      <label className="check-line">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      {preview ? (
        <div className="com-mail-body">
          <p className="mod-kicker" data-mod="com">Preview</p>
          <strong>{preview.subject || '(no subject)'}</strong>
          <p className="muted whitespace-pre">{preview.body || '(empty body)'}</p>
        </div>
      ) : null}
    </Modal>
  );
}

function TemplatesView() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec[] }>('/api/ops/communication/templates');
      setRows(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const varsOf = (t: Rec): string => {
    const v = pick(t, 'variables');
    return Array.isArray(v) ? v.map(String).join(', ') : '';
  };
  return (
    <div className="page">
      <ComHead
        title="Email templates"
        subtitle="Reusable email templates with variables for every business document."
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}>+ New template</button>}
      />
      <ComTabs active="templates" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="card card-pad table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Category</th>
              <th>Subject</th>
              <th>Variables</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">
                    <h3>No templates yet</h3>
                    <p>Create a template to send consistent, branded emails.</p>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((t) => (
                <tr key={String(t.id)} className="row-click" onClick={() => setEditing(t)}>
                  <td className="cell-mono">{String(pick(t, 'code') ?? '')}</td>
                  <td><span className="cell-main">{String(pick(t, 'name') ?? '')}</span></td>
                  <td><Badge value={pick(t, 'category')} /></td>
                  <td className="cell-sub">{trunc(pick(t, 'subject'), 60)}</td>
                  <td className="cell-sub muted">{varsOf(t)}</td>
                  <td>{pick(t, 'isActive', 'is_active') === false ? <Badge value="INACTIVE" /> : <Badge value="ACTIVE" />}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" type="button" onClick={(ev) => { ev.stopPropagation(); setEditing(t); }}>Edit</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {creating ? <TemplateModal initial={null} onClose={() => setCreating(false)} onSaved={() => void load()} /> : null}
      {editing ? <TemplateModal initial={editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
    </div>
  );
}

function DeliveriesView() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(15);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) qs.set('status', status);
      if (channel) qs.set('channel', channel);
      const r = await api<{ data: { rows: Rec[]; pagination: { page: number; pageSize: number; total: number } } }>(
        `/api/ops/communication/deliveries?${qs.toString()}`
      );
      setRows(r.data.rows ?? []);
      setTotal(r.data.pagination?.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load delivery logs');
    }
  }, [page, pageSize, status, channel]);
  useEffect(() => { void load(); }, [load]);
  const recipient = (d: Rec): string => {
    const f = String(pick(d, 'firstName', 'first_name') ?? '');
    const l = String(pick(d, 'lastName', 'last_name') ?? '');
    const name = [f, l].filter(Boolean).join(' ') || String(pick(d, 'username') ?? '');
    const email = String(pick(d, 'userEmail', 'user_email') ?? '');
    return email ? `${name} · ${email}` : name || '—';
  };
  return (
    <div className="page">
      <ComHead
        title="Delivery logs"
        subtitle="Every email, SMS and notification delivery with provider status and retries."
      />
      <ComTabs active="deliveries" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="filter-row">
        <select className="search-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
          <option value="">All statuses</option>
          {['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RETRYING', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{titleCase(s)}</option>
          ))}
        </select>
        <select className="search-input" value={channel} onChange={(e) => { setPage(1); setChannel(e.target.value); }}>
          <option value="">All channels</option>
          {['IN_APP', 'EMAIL', 'PUSH', 'SMS', 'WHATSAPP'].map((ch) => (
            <option key={ch} value={ch}>{titleCase(ch.replace('_', ' '))}</option>
          ))}
        </select>
      </div>
      <div className="card card-pad table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Channel</th>
              <th>Status</th>
              <th>Notification</th>
              <th>Priority</th>
              <th>Retries</th>
              <th>Sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">
                    <h3>No deliveries found</h3>
                    <p>Deliveries will appear here as notifications are sent.</p>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={String(d.id)}>
                  <td><span className="cell-main">{recipient(d)}</span></td>
                  <td><Badge value={pick(d, 'channel')} /></td>
                  <td><Badge value={pick(d, 'status')} /></td>
                  <td className="cell-sub">{trunc(pick(d, 'notificationTitle', 'notification_title'), 60)}</td>
                  <td>{prioBadge(pick(d, 'notificationPriority', 'notification_priority'))}</td>
                  <td>{String(pick(d, 'retryCount', 'retry_count') ?? 0)}</td>
                  <td className="cell-mono">{fmtDate(pick(d, 'sentAt', 'sent_at', 'createdAt', 'created_at'))}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {rows.length > 0 ? <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /> : null}
      </div>
    </div>
  );
}

function SettingRow({ item, onSaved }: { item: Rec; onSaved: () => void }) {
  const raw = pick(item, 'value');
  const value = (raw && typeof raw === 'object' ? raw : { value: String(raw ?? '') }) as Rec;
  const [json, setJson] = useState(JSON.stringify(value, null, 2));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const keys = Object.keys(value);
  const simpleText = keys.length === 1 && keys[0] === 'value' && typeof value.value === 'string';
  const simpleBool = keys.length === 1 && keys[0] === 'enabled' && typeof value.enabled === 'boolean';
  const digestMode = keys.includes('digest');
  const label = titleCase(String(pick(item, 'key') ?? '')).replace(/_/g, ' ');
  const save = async (next: Rec) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/ops/communication/settings', {
        method: 'PUT',
        body: JSON.stringify({
          items: [{ category: pick(item, 'category'), key: pick(item, 'key'), value: next }],
        }),
      });
      setDirty(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the setting');
    } finally {
      setBusy(false);
    }
  };
  const parseJson = (): Rec | null => {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
      return parsed as Rec;
    } catch {
      setErr('Value must be valid JSON (an object)');
      return null;
    }
  };
  return (
    <div className="com-setting">
      <div className="com-setting-main">
        <span className="com-setting-name">{label}</span>
        {err ? <span className="badge badge-red">{err}</span> : null}
        {simpleText ? (
          <input
            className="search-input"
            value={String(value.value ?? '')}
            onChange={(e) => {
              setJson(JSON.stringify({ value: e.target.value }, null, 2));
              setDirty(true);
            }}
          />
        ) : simpleBool ? (
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!value.enabled}
              onChange={(e) => {
                setJson(JSON.stringify({ enabled: e.target.checked }, null, 2));
                setDirty(true);
              }}
            />
            Enabled
          </label>
        ) : digestMode ? (
          <select
            className="search-input"
            value={String(value.digest ?? 'INSTANT')}
            onChange={(e) => {
              setJson(JSON.stringify({ ...value, digest: e.target.value }, null, 2));
              setDirty(true);
            }}
          >
            {['INSTANT', '15_MINUTES', 'HOURLY', 'DAILY', 'WEEKLY'].map((m) => (
              <option key={m} value={m}>{titleCase(m.replace('_', ' '))}</option>
            ))}
          </select>
        ) : (
          <textarea
            className="search-input com-setting-json"
            rows={4}
            value={json}
            onChange={(e) => { setJson(e.target.value); setDirty(true); }}
          />
        )}
      </div>
      {dirty ? (
        <div className="com-setting-actions">
          <button className="btn btn-sm btn-primary" onClick={() => { const next = parseJson(); if (next) void save(next); }} disabled={busy}>
            Save
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setJson(JSON.stringify(value, null, 2)); setDirty(false); setErr(''); }}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SettingsView() {
  const [groups, setGroups] = useState<Map<string, Rec[]>>(new Map());
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec[] }>('/api/ops/communication/settings');
      const g = new Map<string, Rec[]>();
      for (const s of r.data ?? []) {
        const cat = String(pick(s, 'category') ?? 'GENERAL');
        g.set(cat, [...(g.get(cat) ?? []), s]);
      }
      setGroups(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load communication settings');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const groupLabels: Record<string, string> = {
    GENERAL: 'General',
    EMAIL: 'Email',
    NOTIFICATIONS: 'Notifications',
    ESCALATION: 'Escalation',
    SMTP: 'SMTP',
    DIGEST: 'Digest',
    PUSH: 'Push',
  };
  return (
    <div className="page">
      <ComHead
        title="Communication settings"
        subtitle="Digest modes, escalation rules, retry policies and channel configuration."
      />
      <ComTabs active="settings" />
      {error ? <ErrorBanner error={error} /> : null}
      {groups.size === 0 && !error ? (
        <div className="card card-pad empty-state">
          <h3>No settings configured</h3>
          <p>Communication settings will appear here once configured for this company.</p>
        </div>
      ) : (
        [...groups.entries()].map(([cat, items]) => (
          <section key={cat} className="card card-pad">
            <div className="card-head">
              <h3>{groupLabels[cat] ?? titleCase(cat)}</h3>
              <span className="muted">{items.length} setting{items.length > 1 ? 's' : ''}</span>
            </div>
            <div className="stack">
              {items.map((it) => <SettingRow key={String(it.id)} item={it} onSaved={() => void load()} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function CronJobsView() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [runs, setRuns] = useState<Rec[]>([]);
  const [runsError, setRunsError] = useState('');
  const [runsLoading, setRunsLoading] = useState(false);

  const canView = can(user, 'system.cron.view');
  const canManage = can(user, 'system.cron.manage');

  const load = useCallback(async () => {
    try {
      const r = await api<{ data: { items: Rec[] } }>('/api/admin/cron/jobs');
      setRows(r.data?.items ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load cron jobs');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runNow = async (j: Rec) => {
    const id = Number(j.id);
    if (busy) return;
    setBusy('run-' + id);
    try {
      await api(`/api/admin/cron/jobs/${id}/run`, { method: 'POST' });
      await load();
      if (expanded === id) void openRuns(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run job');
    } finally {
      setBusy('');
    }
  };

  const toggle = async (j: Rec) => {
    const id = Number(j.id);
    if (busy) return;
    setBusy('tog-' + id);
    try {
      await api(`/api/admin/cron/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !j.enabled }),
        headers: { 'Content-Type': 'application/json' },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update job');
    } finally {
      setBusy('');
    }
  };

  const openRuns = async (id: number) => {
    setRunsLoading(true);
    setRunsError('');
    try {
      const r = await api<{ data: { items: Rec[] } }>(`/api/admin/cron/jobs/${id}/runs`);
      setRuns(r.data?.items ?? []);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : 'Could not load run history');
    } finally {
      setRunsLoading(false);
    }
  };

  const toggleExpand = (id: number) => {
    if (expanded === id) { setExpanded(null); setRuns([]); return; }
    setExpanded(id);
    void openRuns(id);
  };

  const scheduleOf = (j: Rec): string => {
    const t = String(pick(j, 'scheduleType', 'schedule_type') ?? '');
    const runTime = pick(j, 'runTime', 'run_time');
    const dayOfWeek = pick(j, 'dayOfWeek', 'day_of_week');
    const dayOfMonth = pick(j, 'dayOfMonth', 'day_of_month');
    const interval = pick(j, 'intervalMinutes', 'interval_minutes');
    if (t === 'INTERVAL' && interval) return `Every ${interval} min`;
    if (t === 'WEEKLY') return `Weekly${dayOfWeek ? ' · day ' + dayOfWeek : ''}${runTime ? ' · ' + runTime : ''}`;
    if (t === 'MONTHLY') return `Monthly${dayOfMonth ? ' · day ' + dayOfMonth : ''}${runTime ? ' · ' + runTime : ''}`;
    if (t === 'ONCE') return 'Once';
    return `Daily${runTime ? ' · ' + runTime : ''}`;
  };

  const jobBadge = (j: Rec) => {
    const enabled = !!j.enabled;
    const last = String(pick(j, 'runStatus', 'last_status') ?? '');
    const tone = last === 'SUCCESS' ? 'badge-green' : last === 'FAILED' ? 'badge-red' : enabled ? 'badge-blue' : 'badge-neutral';
    const label = last === 'SUCCESS' ? 'Last run OK' : last === 'FAILED' ? 'Last run failed' : enabled ? 'Enabled' : 'Disabled';
    const icon = last === 'SUCCESS' ? '\u2713' : last === 'FAILED' ? '\u2715' : enabled ? '\u25CF' : '\u2013';
    return <span className={`badge ${tone}`}><span className="badge-icon" aria-hidden>{icon}</span>{label}</span>;
  };

  if (!canView) {
    return (
      <div className="page">
        <ComHead title="Cron Jobs" subtitle="Scheduled background jobs and automation." />
        <ComTabs active="cron" />
        <div className="card card-pad empty-state">
          <h3>No access</h3>
          <p>You need the system.cron.view permission to manage cron jobs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <ComHead
        title="Cron Jobs"
        subtitle="Scheduled background automation for stock, contracts, assets, work orders and approvals."
      />
      <ComTabs active="cron" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="stack">
        {rows.map((j) => {
          const id = Number(j.id);
          return (
            <section key={id} className="card card-pad">
              <div className="card-head">
                <div>
                  <h3 className="cell-mono">{String(j.code)}</h3>
                  <p className="muted">{String(j.name)}</p>
                </div>
                <div className="head-actions">
                  {jobBadge(j)}
                  {canManage ? (
                    <>
                      <button className="btn" disabled={!!busy} onClick={() => void toggle(j)}>
                        {busy === 'tog-' + id ? 'Saving\u2026' : j.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-primary" disabled={!!busy} onClick={() => void runNow(j)}>
                        {busy === 'run-' + id ? 'Running\u2026' : 'Run now'}
                      </button>
                    </>
                  ) : null}
                  <button className="btn" onClick={() => toggleExpand(id)}>
                    {expanded === id ? 'Hide history' : 'History'}
                  </button>
                </div>
              </div>
              <p className="muted">{String(j.description ?? '')}</p>
              <p className="muted">
                <b>Schedule:</b> {scheduleOf(j)}
                <span> · </span>
                <b>Next:</b> {fmtDate(pick(j, 'nextRunAt', 'next_run_at'))}
                {pick(j, 'runFinishedAt', 'last_run_at') ? (
                  <>
                    <span> · </span>
                    <b>Last:</b> {fmtDate(pick(j, 'runFinishedAt', 'last_run_at'))}
                    {pick(j, 'runDurationMs', 'last_run_duration_ms') != null
                      ? ` (${String(pick(j, 'runDurationMs', 'last_run_duration_ms'))} ms)` : ''}
                  </>
                ) : null}
              </p>
              {expanded === id ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  {runsLoading ? <PageLoader /> : null}
                  {runsError ? <ErrorBanner error={runsError} /> : null}
                  {!runsLoading && runs.length === 0 ? (
                    <p className="muted">No runs recorded yet.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Started</th>
                            <th>Finished</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((r) => (
                            <tr key={String(r.id)}>
                              <td className="cell-mono">{fmtDate(pick(r, 'startedAt', 'started_at', 'created_at'))}</td>
                              <td className="cell-mono">{fmtDate(pick(r, 'finishedAt', 'finished_at'))}</td>
                              <td><Badge value={pick(r, 'status')} /></td>
                              <td>{pick(r, 'durationMs', 'duration_ms') != null ? String(pick(r, 'durationMs', 'duration_ms')) + ' ms' : '\u2014'}</td>
                              <td className="muted">{String(pick(r, 'resultSummary', 'result_summary', 'error') ?? '')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {!error && rows.length === 0 ? (
          <div className="card card-pad empty-state">
            <h3>No cron jobs</h3>
            <p>Scheduled automation will appear here once configured.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RulesView() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [eventFilter, setEventFilter] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [busy, setBusy] = useState('');
  const canView = can(user, 'communication.notifications.view');
  const canManage = can(user, 'communication.notifications.manage');
  const load = useCallback(async () => {
    try {
      const qs = eventFilter ? '?event_type=' + encodeURIComponent(eventFilter) : '';
      const r = await api<{ data: Rec[] }>('/api/ops/communication/rules' + qs);
      setRows(r.data ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load notification rules');
    }
  }, [eventFilter]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ data: { eventTypes: string[] } }>('/api/ops/communication/preferences');
        setEventTypes(r.data?.eventTypes ?? []);
      } catch { /* event list is optional */ }
    })();
  }, []);
  const toggle = async (r: Rec) => {
    const id = Number(r.id);
    if (busy) return;
    setBusy('tog-' + id);
    try {
      await api('/api/ops/communication/rules/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !pick(r, 'isActive', 'is_active') }),
        headers: { 'Content-Type': 'application/json' },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the rule');
    } finally {
      setBusy('');
    }
  };
  const channelsOf = (r: Rec): string[] =>
    (Array.isArray(pick(r, 'channels')) ? (pick(r, 'channels') as unknown[]) : []).map(String);
  const rolesOf = (r: Rec): string[] =>
    (Array.isArray(pick(r, 'roleCodes', 'role_codes')) ? (pick(r, 'roleCodes', 'role_codes') as unknown[]) : []).map(String);
  if (!canView) {
    return (
      <div className="page">
        <ComHead title="Notification Rules" subtitle="Automated routing rules for events." />
        <ComTabs active="rules" />
        <div className="card card-pad empty-state">
          <h3>No access</h3>
          <p>You need the communication.notifications.view permission to view rules.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <ComHead
        title="Notification Rules"
        subtitle="Automated routing rules that decide who is notified for each event type."
        actions={canManage ? (
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>+ New Rule</button>
        ) : undefined}
      />
      <ComTabs active="rules" />
      {error ? <ErrorBanner error={error} /> : null}
      <div className="stack">
        <div className="toolbar">
          <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} aria-label="Filter by event type">
            <option value="">All event types</option>
            {eventTypes.map((et) => <option key={et} value={et}>{et}</option>)}
          </select>
        </div>
        <div className="card card-pad table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Event Type</th>
                <th>Channels</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <h3>No notification rules</h3>
                      <p>Create a rule to control how events are routed to users.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const active = pick(r, 'isActive', 'is_active') !== false;
                  return (
                    <tr key={String(r.id)}>
                      <td><span className="cell-main">{String(pick(r, 'name') ?? '')}</span></td>
                      <td><Badge value={pick(r, 'eventType', 'event_type')} /></td>
                      <td className="cell-sub">{channelsOf(r).map(titleCase).join(', ') || '—'}</td>
                      <td className="cell-sub">{rolesOf(r).join(', ') || 'Everyone'}</td>
                      <td>{active ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />}</td>
                      <td className="cell-mono">{fmtDate(pick(r, 'createdAt', 'created_at'))}</td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditing(r)} disabled={!canManage}>Edit</button>
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => void toggle(r)} disabled={!canManage || busy === 'tog-' + String(r.id)}>
                            {active ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      {creating ? <RuleModal initial={null} onClose={() => setCreating(false)} onSaved={() => void load()} /> : null}
      {editing ? <RuleModal initial={editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
    </div>
  );
}

function RuleModal({ initial, onClose, onSaved }: { initial: Rec | null; onClose: () => void; onSaved: () => void }) {
  const init: Rec = initial ?? {};
  const [name, setName] = useState(String(pick(init, 'name') ?? ''));
  const [eventType, setEventType] = useState(String(pick(init, 'eventType', 'event_type') ?? ''));
  const [channels, setChannels] = useState<string[]>(
    (Array.isArray(pick(init, 'channels')) ? (pick(init, 'channels') as unknown[]) : ['IN_APP']).map(String)
  );
  const [roleCodes, setRoleCodes] = useState<string[]>(
    (Array.isArray(pick(init, 'roleCodes', 'role_codes')) ? (pick(init, 'roleCodes', 'role_codes') as unknown[]) : []).map(String)
  );
  const [conditions, setConditions] = useState(() => {
    const v = pick(init, 'conditions');
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
  const [isActive, setIsActive] = useState(pick(init, 'isActive', 'is_active') !== false);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [roles, setRoles] = useState<Rec[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const [pref, roleRes] = await Promise.all([
          api<{ data: { eventTypes: string[] } }>('/api/ops/communication/preferences'),
          api<{ data: { data: Rec[] } }>('/api/admin/roles?pageSize=100'),
        ]);
        setEventTypes(pref.data?.eventTypes ?? []);
        setRoles(roleRes.data?.data ?? []);
      } catch { /* optional enrichment */ }
    })();
  }, []);
  const toggleChannel = (ch: string) => {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch]));
  };
  const toggleRole = (code: string) => {
    setRoleCodes((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  };
  const save = async () => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      let conditionsJson: Record<string, unknown> | undefined;
      const trimmed = conditions.trim();
      if (trimmed) {
        try {
          conditionsJson = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          throw new Error('Conditions must be valid JSON (or empty)');
        }
      }
      const body: Record<string, unknown> = {
        name,
        event_type: eventType,
        channels,
        role_codes: roleCodes,
        is_active: isActive,
      };
      if (conditionsJson) body.conditions = conditionsJson;
      await api(initial ? '/api/ops/communication/rules/' + String(init.id) : '/api/ops/communication/rules', {
        method: initial ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the rule');
    } finally {
      setBusy(false);
    }
  };
  const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'];
  return (
    <Modal
      title={initial ? 'Edit notification rule' : 'New notification rule'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={busy || !name || !eventType}>
            {busy ? 'Saving…' : 'Save rule'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Supplier invoice approval" />
        </div>
        <div className="field">
          <label>Event Type</label>
          <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="">Select event…</option>
            {eventTypes.map((et) => <option key={et} value={et}>{et}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Channels</label>
        <div className="stack">
          {CHANNELS.map((ch) => (
            <label key={ch} className="check-line">
              <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggleChannel(ch)} />
              {titleCase(ch)}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Target Roles</label>
        <div className="card card-pad" style={{ maxHeight: 180, overflowY: 'auto' }}>
          {roles.length === 0 ? (
            <p className="muted">No roles loaded.</p>
          ) : (
            roles.map((r) => {
              const code = String(pick(r, 'code') ?? '');
              const roleName = String(pick(r, 'name') ?? '');
              return (
                <label key={code} className="check-line">
                  <input type="checkbox" checked={roleCodes.includes(code)} onChange={() => toggleRole(code)} />
                  {roleName || code}
                </label>
              );
            })
          )}
        </div>
        <p className="muted hint">Leave empty to notify all users for this event.</p>
      </div>
      <div className="field">
        <label>Conditions (JSON, optional)</label>
        <textarea rows={3} value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder='{"amount_min": 10000000}' />
      </div>
      <label className="check-line">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
    </Modal>
  );
}

function PreferencesView() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const canView = can(user, 'communication.notifications.view');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: { rows: Rec[] } }>('/api/ops/communication/preferences');
      setRows(r.data?.rows ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load preferences');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const setChannel = (eventType: string, key: string, value: boolean) => {
    setSaved(false);
    setRows((prev) => prev.map((r) => (String(pick(r, 'eventType')) === eventType ? { ...r, [key]: value } : r)));
  };
  const setDigest = (eventType: string, digest: string) => {
    setSaved(false);
    setRows((prev) => prev.map((r) => (String(pick(r, 'eventType')) === eventType ? { ...r, digest } : r)));
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const items = rows.map((r) => ({
        event_type: String(pick(r, 'eventType')),
        inApp: !!r.inApp,
        email: !!r.email,
        push: !!r.push,
        sms: !!r.sms,
        whatsapp: !!r.whatsapp,
        digest: String(r.digest ?? 'INSTANT'),
        criticalBypass: !!r.criticalBypass,
      }));
      await api('/api/ops/communication/preferences', {
        method: 'PUT',
        body: JSON.stringify({ items }),
        headers: { 'Content-Type': 'application/json' },
      });
      setSaved(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save preferences');
    } finally {
      setSaving(false);
    }
  };
  const filtered = rows.filter((r) =>
    String(pick(r, 'eventType')).toLowerCase().includes(filter.trim().toLowerCase())
  );
  if (!canView) {
    return (
      <div className="page">
        <ComHead title="My Preferences" subtitle="Personal notification delivery settings." />
        <ComTabs active="preferences" />
        <div className="card card-pad empty-state">
          <h3>No access</h3>
          <p>You need the communication.notifications.view permission to manage preferences.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <ComHead
        title="My Preferences"
        subtitle="Choose how you receive notifications for each event type. Critical events always bypass quiet periods."
        actions={
          <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
        }
      />
      <ComTabs active="preferences" />
      {error ? <ErrorBanner error={error} /> : null}
      {saved ? <div className="notice-banner">✓ Preferences saved.</div> : null}
      <div className="toolbar">
        <input className="search-input" placeholder="Filter event type…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="card card-pad table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Event Type</th>
              <th>In-App</th>
              <th>Email</th>
              <th>Push</th>
              <th>SMS</th>
              <th>WhatsApp</th>
              <th>Digest</th>
              <th>Critical</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">
                    <h3>No preferences found</h3>
                    <p>Adjust the filter to see matching event types.</p>
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const et = String(pick(r, 'eventType'));
                return (
                  <tr key={et}>
                    <td><Badge value={et} /></td>
                    <td><input type="checkbox" checked={!!r.inApp} onChange={(e) => setChannel(et, 'inApp', e.target.checked)} aria-label={et + ' in-app'} /></td>
                    <td><input type="checkbox" checked={!!r.email} onChange={(e) => setChannel(et, 'email', e.target.checked)} aria-label={et + ' email'} /></td>
                    <td><input type="checkbox" checked={!!r.push} onChange={(e) => setChannel(et, 'push', e.target.checked)} aria-label={et + ' push'} /></td>
                    <td><input type="checkbox" checked={!!r.sms} onChange={(e) => setChannel(et, 'sms', e.target.checked)} aria-label={et + ' sms'} /></td>
                    <td><input type="checkbox" checked={!!r.whatsapp} onChange={(e) => setChannel(et, 'whatsapp', e.target.checked)} aria-label={et + ' whatsapp'} /></td>
                    <td>
                      <select value={String(r.digest ?? 'INSTANT')} onChange={(e) => setDigest(et, e.target.value)} aria-label={et + ' digest'}>
                        {['INSTANT', '15_MIN', 'HOURLY', 'DAILY', 'WEEKLY'].map((d) => (
                          <option key={d} value={d}>{titleCase(d)}</option>
                        ))}
                      </select>
                    </td>
                    <td><input type="checkbox" checked={!!r.criticalBypass} onChange={(e) => setChannel(et, 'criticalBypass', e.target.checked)} aria-label={et + ' critical bypass'} /></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="muted hint">Critical events (security alerts, machine breakdowns) are always delivered instantly regardless of digest mode.</p>
    </div>
  );
}


export default function CommunicationFlow({ path }: { path: string }) {
  const { view, id } = parseCom(path);
  switch (view) {
    case 'messages': return <MessagesView initialId={id} />;
    case 'notifications': return <NotificationsView key="ntf" archived={false} />;
    case 'archive': return <NotificationsView key="arc" archived />;
    case 'work': return <ComWorkView />;
    case 'admin': return <CommunicationAdmin />;
    case 'email': return <EmailView key="email" preset="inbox" />;
    case 'sent': return <EmailView key="sent" preset="sent" />;
    case 'drafts': return <EmailView key="drafts" preset="drafts" />;
    case 'announcements': return <AnnouncementsView />;
    case 'templates': return <TemplatesView />;
    case 'deliveries': return <DeliveriesView />;
    case 'settings': return <SettingsView />;
    case 'preferences': return <PreferencesView />;
    case 'rules': return <RulesView />;
    case 'cron': return <CronJobsView />;
    default: return <CommandCenter />;
  }
}
