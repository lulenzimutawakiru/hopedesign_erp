import { type CSSProperties, type ReactNode } from 'react';
import { navigate } from '../../router';
import { itemVisible } from '../../nav';
import { useAuth } from '../../auth';
import { fmtDate, fmtMoney, fmtNum } from '../../api';

export type Rec = Record<string, unknown>;

export const MAIL_ACCENT = '#0F766E';
export const MAIL_TINT = 'rgba(15, 118, 110, 0.12)';

/** The mail module rides the Communication palette (`--mod-com`). */
export function modStyle(): CSSProperties {
  return {
    '--tile-accent': MAIL_ACCENT,
    '--tile-tint': MAIL_TINT,
    '--mod-com': MAIL_ACCENT,
  } as CSSProperties;
}

export function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/* ------------------------------------------------------------------ *
 * Module chrome
 * ------------------------------------------------------------------ */

export function MailHead({
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
        <p className="mod-kicker" data-mod="com">{kicker ?? 'Company mail'}</p>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ maxWidth: 900 }}>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

export const MAIL_TABS: Array<[string, string, string, string]> = [
  ['inbox', 'Inbox', '/communication/mail', 'communication.emails.view'],
  ['drafts', 'Drafts', '/communication/mail/drafts', 'communication.emails.view'],
  ['sent', 'Sent', '/communication/mail/sent', 'communication.emails.view'],
  ['scheduled', 'Scheduled', '/communication/mail/scheduled', 'communication.emails.view'],
  ['outbox', 'Outbox', '/communication/mail/outbox', 'communication.mail_scheduler.view'],
  ['archive', 'Archive', '/communication/mail/archive', 'communication.emails.view'],
  ['approvals', 'Approvals', '/communication/mail/approvals', 'communication.mail_approvals.view'],
  ['mailboxes', 'Mailboxes', '/communication/mail/mailboxes', 'communication.mailboxes.view'],
  ['settings', 'Settings', '/communication/mail/settings', 'communication.mailboxes.manage'],
];

export function MailTabs({ active }: { active: string }) {
  const { user } = useAuth();
  const tabs = MAIL_TABS.filter(([, , , perm]) => itemVisible(user, { perm }));
  return (
    <nav className="spend-tabs sd-chip-tabs" aria-label="Company mail">
      {tabs.map(([key, text, href]) => (
        <button
          key={key}
          type="button"
          className={'spend-tab' + (key === active ? ' is-on' : '')}
          aria-current={key === active ? 'page' : undefined}
          onClick={() => navigate(href)}
        >
          {text}
        </button>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Presentational primitives (same vocabulary as the Service Desk views)
 * ------------------------------------------------------------------ */

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
    '--tile-accent': accent ?? MAIL_ACCENT,
    '--tile-tint': tint ?? MAIL_TINT,
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
  id,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  id?: string;
}) {
  return (
    <section className={'card' + (pad ? ' card-pad' : '')} id={id}>
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

/** Reload control shared by every mail surface. */
export function RefreshBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn-sm" onClick={onClick} disabled={disabled}>
      {disabled ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function whenText(v: unknown): string {
  const raw = s(v);
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return fmtDate(raw);
}

export function sizeText(bytes: unknown): string {
  const n = num(bytes);
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function moneyText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return fmtMoney(v);
}

export function countText(v: unknown): string {
  return fmtNum(v);
}

export function initials(name: unknown): string {
  const parts = s(name).trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}

export function truncate(text: unknown, max = 90): string {
  const raw = s(text).replace(/\s+/g, ' ').trim();
  if (raw.length <= max) return raw;
  return raw.slice(0, max - 1) + '…';
}
