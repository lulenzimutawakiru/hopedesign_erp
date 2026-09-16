import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { navigate } from '../router';
import { api } from '../api';
import { itemVisible } from '../nav';
import { useAuth } from '../auth';

export type Rec = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * Data access
 * ------------------------------------------------------------------ */

interface Envelope<T> {
  data?: T;
}

/**
 * Every Service Desk endpoint answers with `{ data: ... }`. Unwrapping the
 * envelope in one place keeps the views free of the wrapping dance.
 */
export async function sdApi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const body = await api<Envelope<T>>(path, init);
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    return (body as Envelope<T>).data as T;
  }
  return body as unknown as T;
}

export function sdPost<T = unknown>(path: string, payload?: unknown): Promise<T> {
  return sdApi<T>(path, {
    method: 'POST',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export function sdPatch<T = unknown>(path: string, payload?: unknown): Promise<T> {
  return sdApi<T>(path, {
    method: 'PATCH',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export function sdErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

export function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function has(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

export function label(v: unknown): string {
  return s(v)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function dash(v: unknown): string {
  return has(v) ? s(v) : '\u2013';
}

export function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

/* ------------------------------------------------------------------ *
 * Priority - impact + urgency. Never colour alone: the chip always carries
 * the P-code, the severity word and a filled-bar glyph.
 * ------------------------------------------------------------------ */

export interface PriorityMeta {
  code: string;
  label: string;
  bars: number;
  tone: string;
  rank: number;
}

const PRIORITY_META: Record<string, PriorityMeta> = {
  P1: { code: 'P1', label: 'Critical', bars: 4, tone: 'critical', rank: 1 },
  P2: { code: 'P2', label: 'High', bars: 3, tone: 'high', rank: 2 },
  P3: { code: 'P3', label: 'Medium', bars: 2, tone: 'medium', rank: 3 },
  P4: { code: 'P4', label: 'Low', bars: 1, tone: 'low', rank: 4 },
};

export function priorityMeta(code: unknown): PriorityMeta {
  const key = s(code).toUpperCase();
  const found = PRIORITY_META[key];
  if (found) return found;
  return { code: key || 'P?', label: 'Unclassified', bars: 0, tone: 'none', rank: 9 };
}

export function PriorityChip({ value, compact }: { value: unknown; compact?: boolean }) {
  const m = priorityMeta(value);
  return (
    <span className={'sd-prio sd-prio-' + m.tone} title={'Priority ' + m.code + ' \u2013 ' + m.label}>
      <span className="sd-prio-bars" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < m.bars ? 'on' : undefined} />
        ))}
      </span>
      <b>{m.code}</b>
      {!compact && <span className="sd-prio-lbl">{m.label}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Status + SLA chips
 * ------------------------------------------------------------------ */

export interface StatusMeta {
  code: string;
  label: string;
  tone: string;
  open: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  NEW: { code: 'NEW', label: 'New', tone: 'new', open: true },
  OPEN: { code: 'OPEN', label: 'Open', tone: 'open', open: true },
  ASSIGNED: { code: 'ASSIGNED', label: 'Assigned', tone: 'assigned', open: true },
  IN_PROGRESS: { code: 'IN_PROGRESS', label: 'In progress', tone: 'progress', open: true },
  PENDING_REQUESTER: { code: 'PENDING_REQUESTER', label: 'Pending requester', tone: 'waiting', open: true },
  PENDING_VENDOR: { code: 'PENDING_VENDOR', label: 'Pending vendor', tone: 'waiting', open: true },
  RESOLVED: { code: 'RESOLVED', label: 'Resolved', tone: 'resolved', open: false },
  CLOSED: { code: 'CLOSED', label: 'Closed', tone: 'closed', open: false },
  CANCELLED: { code: 'CANCELLED', label: 'Cancelled', tone: 'cancelled', open: false },
  REOPENED: { code: 'REOPENED', label: 'Reopened', tone: 'reopened', open: true },
  ESCALATED: { code: 'ESCALATED', label: 'Escalated', tone: 'escalated', open: true },
};

export function statusMeta(value: unknown): StatusMeta {
  const key = s(value).toUpperCase();
  const found = STATUS_META[key];
  if (found) return found;
  return { code: key || '?', label: key ? label(key) : 'Unknown', tone: 'unknown', open: false };
}

export function StatusChip({ value }: { value: unknown }) {
  const m = statusMeta(value);
  return (
    <span className={'sd-st sd-st-' + m.tone}>
      <span className="sd-st-dot" aria-hidden />
      {m.label}
    </span>
  );
}

const SLA_META: Record<string, { label: string; tone: string }> = {
  ON_TRACK: { label: 'On track', tone: 'ok' },
  MET: { label: 'Met', tone: 'ok' },
  WARNING: { label: 'Warning', tone: 'warn' },
  AT_RISK: { label: 'At risk', tone: 'warn' },
  BREACHED: { label: 'Breached', tone: 'breach' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  PENDING: { label: 'Pending', tone: 'muted' },
  NONE: { label: 'No SLA', tone: 'muted' },
};

export function slaMeta(value: unknown): { label: string; tone: string } {
  const key = s(value).toUpperCase();
  return SLA_META[key] ?? SLA_META.NONE;
}

export function SlaChip({ state, title }: { state: unknown; title?: string }) {
  const m = slaMeta(state);
  return (
    <span className={'sd-sla sd-sla-' + m.tone} title={title}>
      {m.label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Time formatting
 * ------------------------------------------------------------------ */

export function fmtDT(v: unknown): string {
  const raw = s(v);
  if (!raw) return '\u2013';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDay(v: unknown): string {
  const raw = s(v);
  if (!raw) return '\u2013';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function fmtAgo(v: unknown): string {
  const raw = s(v);
  if (!raw) return '\u2013';
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return raw;
  const diff = Date.now() - t;
  const past = diff >= 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  const wrap = (n: number, unit: string) => (past ? n + unit + ' ago' : 'in ' + n + unit);
  if (mins < 1) return 'just now';
  if (mins < 60) return wrap(mins, 'm');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return wrap(hrs, 'h');
  const days = Math.round(hrs / 24);
  if (days < 30) return wrap(days, 'd');
  return fmtDay(raw);
}

export function fmtDur(mins: unknown): string {
  const m = num(mins);
  if (!m) return '\u2013';
  if (m < 60) return Math.round(m) + 'm';
  const h = m / 60;
  if (h < 24) return (Math.round(h * 10) / 10) + 'h';
  return (Math.round((h / 24) * 10) / 10) + 'd';
}

export function fmtMinutesClock(mins: unknown): string {
  const v = num(mins);
  if (v <= 0) return '\u2013';
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  if (!h) return m + 'm';
  return h + 'h ' + m + 'm';
}

/* ------------------------------------------------------------------ *
 * Ticket navigation helpers
 * ------------------------------------------------------------------ */

export function ticketRef(t: Rec | null | undefined): string {
  if (!t) return '';
  return s(t.ticket_number ?? t.ticketNumber ?? t.number ?? t.id);
}

export function ticketHref(id: unknown, base?: string): string {
  return (base ?? '/service-desk/tickets') + '/' + s(id);
}

export function openTicket(id: unknown, base?: string): void {
  navigate(ticketHref(id, base));
}

export function subjectOf(t: Rec | null | undefined): string {
  if (!t) return '\u2013';
  return s(t.subject ?? t.title) || '\u2013';
}

export function isOpenStatus(v: unknown): boolean {
  return statusMeta(v).open;
}

/* ------------------------------------------------------------------ *
 * Module chrome
 * ------------------------------------------------------------------ */

const SD_ACCENT = '#0E7490';
const SD_TINT = 'rgba(14, 116, 144, 0.12)';

export function modStyle(): CSSProperties {
  return {
    '--tile-accent': SD_ACCENT,
    '--tile-tint': SD_TINT,
    '--mod-sd': SD_ACCENT,
  } as CSSProperties;
}

export function SdHead({
  title,
  sub,
  actions,
  kicker,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  kicker?: string;
}) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="sd">{kicker ?? 'Service desk'}</p>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ maxWidth: 900 }}>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

export const SD_TABS: Array<[string, string, string, string]> = [
  ['portal', 'My Service Desk', '/service-desk', 'service_desk.tickets.view'],
  ['workspace', 'Agent Workspace', '/service-desk/workspace', 'service_desk.tickets.assign'],
  ['dashboard', 'Dashboards', '/service-desk/dashboard', 'service_desk.dashboards.agent'],
  ['tickets', 'Tickets', '/service-desk/tickets', 'service_desk.tickets.view'],
  ['queues', 'Queues & Teams', '/service-desk/queues', 'service_desk.tickets.assign'],
  ['knowledge', 'Knowledge Base', '/service-desk/knowledge', 'service_desk.knowledge.view'],
  ['problems', 'Problems', '/service-desk/problems', 'service_desk.problems.view'],
  ['changes', 'Changes', '/service-desk/changes', 'service_desk.changes.view'],
  ['access', 'Access Requests', '/service-desk/access', 'service_desk.access_requests.view'],
  ['scan', 'Asset Scan', '/service-desk/scan', 'service_desk.asset_scans.view'],
  ['reports', 'Reporting', '/service-desk/reports', 'service_desk.reports.view'],
  ['config', 'Configuration', '/service-desk/config', 'service_desk.sla.manage'],
];

export function SdTabs({ active }: { active: string }) {
  const { user } = useAuth();
  const tabs = SD_TABS.filter(([, , , perm]) => itemVisible(user, { perm }));
  return (
    <nav className="spend-tabs sd-chip-tabs" aria-label="Service desk">
      {tabs.map(([key, text, href]) => (
        <button
          key={key}
          type="button"
          className={'spend-tab' + (key === active ? ' is-on' : '')}
          onClick={() => navigate(href)}
        >
          {text}
        </button>
      ))}
    </nav>
  );
}

export function KpiTile({
  label: text,
  value,
  sub,
  icon,
  accent,
  tint,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  accent?: string;
  tint?: string;
  onClick?: () => void;
}) {
  const style = {
    '--tile-accent': accent ?? SD_ACCENT,
    '--tile-tint': tint ?? SD_TINT,
  } as CSSProperties;
  return (
    <button type="button" className="kpi-tile" style={style} onClick={onClick} disabled={!onClick}>
      {icon !== undefined && <span className="kpi-tile-icon" aria-hidden>{icon}</span>}
      <span className="kpi-tile-body">
        <span className="kpi-tile-label">{text}</span>
        <span className="kpi-tile-value">{value}</span>
        {sub !== undefined && sub !== null && <span className="kpi-tile-sub">{sub}</span>}
      </span>
    </button>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="sd-kpi-row">{children}</div>;
}

export function SecCard({
  title,
  sub,
  actions,
  children,
  pad,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <section className={'card' + (pad ? ' card-pad' : '')}>
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>{sub}</p>}
        </div>
        {actions && <div className="sd-card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="sd-empty-cell">{children}</td>
    </tr>
  );
}

export function Nothing({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="sd-nothing">
      <p>{text}</p>
      {action && onAction && (
        <button className="btn btn-primary" onClick={onAction}>{action}</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared data hooks
 * ------------------------------------------------------------------ */

export interface SdMeta {
  ticketTypes: string[];
  statuses: string[];
  priorities: string[];
  impacts: string[];
  urgencies: string[];
  sources: string[];
  classifications: string[];
  contactMethods: string[];
  assignmentStrategies: string[];
  relationTypes: string[];
  resolutionCodes: string[];
  reports: Array<{ code: string; title: string; groupBy: string; columns: Array<{ key: string; label: string; type: string }> }>;
  module?: string;
  surface?: string;
  version?: string;
}


let metaCache: SdMeta | null = null;

export function useSdMeta(): { meta: SdMeta | null; error: unknown } {
  const [meta, setMeta] = useState<SdMeta | null>(metaCache);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (metaCache) return;
    let alive = true;
    sdApi<SdMeta>('/api/service-desk/meta')
      .then((m) => {
        metaCache = m;
        if (alive) setMeta(m);
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { meta, error };
}

/* ------------------------------------------------------------------ *
 * SLA presentation
 * ------------------------------------------------------------------ */

export function SlaMeter({ sla }: { sla: Rec | null | undefined }) {
  if (!sla) return <p className="muted" style={{ margin: 0 }}>No SLA policy applies to this ticket.</p>;
  const resolutionDue = s(sla.resolution_due_at);
  const total = num(sla.resolution_minutes);
  let elapsed = 0;
  if (total > 0 && resolutionDue) {
    const dueT = new Date(resolutionDue).getTime();
    const winMs = total * 60000;
    const elapsedMs = winMs - (dueT - Date.now());
    elapsed = Math.max(0, Math.min(100, Math.round((elapsedMs / winMs) * 100)));
  }
  const respState = s(sla.response_state) || 'PENDING';
  const resState = s(sla.resolution_state) || 'PENDING';
  const tone = (v: string) => slaMeta(v).tone;
  return (
    <div className="sd-sla-block">
      <div className="sd-sla-line">
        <span className="sd-sla-k">Response</span>
        <SlaChip state={respState} />
        <span className="sd-sla-v">
          target {fmtDur(sla.response_minutes)} &middot; due {fmtAgo(sla.response_due_at)}
        </span>
      </div>
      <div className="sd-sla-line">
        <span className="sd-sla-k">Resolution</span>
        <SlaChip state={resState} />
        <span className="sd-sla-v">
          target {fmtDur(sla.resolution_minutes)} &middot; due {fmtAgo(sla.resolution_due_at)}
        </span>
      </div>
      <div className={'sd-sla-track sd-sla-track-' + tone(resState)}>
        <span style={{ width: elapsed + '%' }} />
      </div>
      <div className="sd-sla-foot muted">
        <span>Policy {dash(sla.policy_code ?? sla.policy_name)}</span>
        <span>Basis {label(sla.time_basis)}</span>
        <span>Paused {fmtDur(sla.paused_minutes)}</span>
        {num(sla.breaches) > 0 && <span className="sd-breach-count">{num(sla.breaches)} breach(es)</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ticket table
 * ------------------------------------------------------------------ */

export interface TicketColumn {
  key: string;
  label: string;
  render: (t: Rec) => ReactNode;
  width?: string;
}

export const TICKET_QUEUE_COLUMNS: TicketColumn[] = [
  { key: 'ref', label: 'Ticket', width: '150px', render: (t) => (
    <div className="sd-ref-cell">
      <b className="td-cell-mono">{ticketRef(t)}</b>
      <span className="sub muted">{label(t.ticket_type)}</span>
    </div>
  ) },
  { key: 'subject', label: 'Subject', render: (t) => (
    <div className="sd-subj-cell">
      <span className="sd-subj">{subjectOf(t)}</span>
      <span className="sub muted">
        {dash(t.category_name)}
        {s(t.subcategory_name) ? ' / ' + s(t.subcategory_name) : ''}
      </span>
    </div>
  ) },
  { key: 'requester', label: 'Requester', width: '170px', render: (t) => (
    <div className="sd-req-cell">
      <span>{dash(t.requester_name)}</span>
      <span className="sub muted td-cell-mono">{dash(t.requester_employee_no)}</span>
    </div>
  ) },
  { key: 'priority', label: 'Priority', width: '110px', render: (t) => <PriorityChip value={t.priority} compact /> },
  { key: 'status', label: 'Status', width: '140px', render: (t) => <StatusChip value={t.status} /> },
  { key: 'assignee', label: 'Assigned', width: '150px', render: (t) => (
    <span className="muted">{s(t.assignee_name) || s(t.queue_name) || 'Unassigned'}</span>
  ) },
  { key: 'sla', label: 'SLA', width: '110px', render: (t) => <SlaChip state={t.sla_resolution_state ?? t.sla_state} title={'Resolution SLA'} /> },
  { key: 'age', label: 'Age', width: '90px', render: (t) => <span className="muted">{fmtAgo(t.opened_at ?? t.created_at)}</span> },
];

export function TicketTable({
  rows,
  onOpen,
  columns,
  empty,
}: {
  rows: Rec[];
  onOpen: (t: Rec) => void;
  columns?: TicketColumn[];
  empty?: string;
}) {
  const cols = columns ?? TICKET_QUEUE_COLUMNS;
  return (
    <div className="table-wrap">
      <table className="table sd-ticket-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <EmptyRow cols={cols.length}>{empty ?? 'No tickets match the current filters.'}</EmptyRow>
          )}
          {rows.map((t) => (
            <tr
              key={s(t.id)}
              className={'sd-ticket-row sd-row-' + priorityMeta(t.priority).tone}
              onClick={() => onOpen(t)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(t);
                }
              }}
            >
              {cols.map((c) => (
                <td key={c.key}>{c.render(t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Activity, comments, attachments
 * ------------------------------------------------------------------ */

export interface ActivityItem {
  id: string | number;
  kind: string;
  at: string;
  actorUserId?: number | null;
  actorName?: string | null;
  body?: string | null;
  meta?: Rec | null;
}

const ACT_TONE: Record<string, string> = {
  CREATED: 'create',
  ASSIGNED: 'assign',
  REASSIGNED: 'assign',
  STATUS: 'status',
  COMMENT: 'reply',
  NOTE: 'note',
  ATTACHMENT: 'file',
  ESCALATION: 'escalate',
  SLA: 'sla',
  RESOLUTION: 'resolve',
  CLOSURE: 'close',
  REOPEN: 'reopen',
  PRIORITY: 'priority',
};

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (!items || items.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>No activity recorded yet.</p>;
  }
  return (
    <ol className="sd-timeline">
      {items.map((a) => {
        const tone = ACT_TONE[s(a.kind).toUpperCase()] ?? 'other';
        return (
          <li key={s(a.id)} className={'sd-tl-item sd-tl-' + tone}>
            <span className="sd-tl-dot" aria-hidden />
            <div className="sd-tl-body">
              <div className="sd-tl-top">
                <b>{label(a.kind)}</b>
                <span className="muted">{fmtAgo(a.at)}</span>
              </div>
              {a.body && <p className="sd-tl-text">{s(a.body)}</p>}
              <span className="sd-tl-actor muted">
                {s(a.actorName) || 'System'} &middot; {fmtDT(a.at)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function CommentList({ comments, canSeeInternal }: { comments: Rec[]; canSeeInternal: boolean }) {
  const [showInternal, setShowInternal] = useState(true);
  const visible = comments.filter((c) => (c.is_internal ? canSeeInternal && showInternal : true));
  if (comments.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>No conversation yet. Start the thread below.</p>;
  }
  return (
    <div className="sd-thread">
      {canSeeInternal && (
        <div className="sd-thread-toggle">
          <button
            className={showInternal ? 'chip active' : 'chip'}
            onClick={() => setShowInternal((v) => !v)}
          >
            {showInternal ? 'Hiding nothing' : 'Internal notes hidden'}
          </button>
          <span className="muted">
            {comments.filter((c) => c.is_internal).length} internal &middot;{' '}
            {comments.filter((c) => !c.is_internal).length} public
          </span>
        </div>
      )}
      {visible.map((c) => {
        const internal = Boolean(c.is_internal);
        return (
          <article key={s(c.id)} className={internal ? 'sd-msg sd-msg-internal' : 'sd-msg sd-msg-public'}>
            <header>
              <b>{dash(c.author_name ?? c.user_name ?? c.created_by_name)}</b>
              <span className={'sd-vis-tag ' + (internal ? 'internal' : 'public')}>
                {internal ? 'Internal note' : 'Public reply'}
              </span>
              <span className="muted">{fmtAgo(c.created_at)}</span>
            </header>
            <p>{s(c.body)}</p>
            {internal && <p className="sd-vis-warn">Not visible to the requester.</p>}
          </article>
        );
      })}
    </div>
  );
}

export function AttachmentList({ items, onDownload }: { items: Rec[]; onDownload?: (a: Rec) => void }) {
  if (!items || items.length === 0) return <p className="muted" style={{ margin: 0 }}>No attachments.</p>;
  return (
    <ul className="sd-files">
      {items.map((f) => (
        <li key={s(f.id)}>
          <button className="sd-file" onClick={() => onDownload?.(f)}>
            <span className="sd-file-name">{dash(f.file_name ?? f.filename)}</span>
            <span className="muted">
              {f.file_size ? Math.max(1, Math.round(num(f.file_size) / 1024)) + ' KB' : ''} {fmtAgo(f.created_at)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TagList({ tags }: { tags: unknown }) {
  const list = Array.isArray(tags) ? tags.map((t) => s(t)).filter(Boolean) : [];
  if (list.length === 0) return null;
  return (
    <div className="chips sd-tags">
      {list.map((t) => (
        <span key={t} className="chip">{t}</span>
      ))}
    </div>
  );
}
