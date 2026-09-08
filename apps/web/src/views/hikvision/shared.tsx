import type { ReactNode } from 'react';
import { pick } from '../../helpers';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';

export type Rec = Record<string, unknown>;

export const toStr = (v: unknown, d = ''): string =>
  v === null || v === undefined ? d : String(v);

export const toNum = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function pickS(r: Rec | null | undefined, ...keys: string[]): string {
  if (!r) return '';
  return toStr(pick(r, ...keys));
}

export function pickN(r: Rec | null | undefined, ...keys: string[]): number {
  if (!r) return 0;
  return toNum(pick(r, ...keys), 0);
}

export function pickB(r: Rec | null | undefined, ...args: (string | boolean)[]): boolean {
  if (!r) return false;
  let def = false;
  const keys: string[] = [];
  for (const a of args) {
    if (typeof a === 'boolean') def = a;
    else keys.push(a);
  }
  if (keys.length === 0) return def;
  const v = pick(r, ...keys);
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 1 || String(v).toLowerCase() === 'true';
}

const B = {
  green: 'badge-green',
  amber: 'badge-amber',
  red: 'badge-red',
  blue: 'badge-blue',
  purple: 'badge-purple',
  neutral: 'badge-neutral',
  progress: 'badge-progress',
  critical: 'badge-critical',
  hold: 'badge-hold',
};

export const PURPOSE_LABEL: Record<string, string> = {
  ENTRY: 'Entry',
  EXIT: 'Exit',
  ATTENDANCE: 'Attendance',
  BREAK_ENTRY: 'Break entry',
  BREAK_EXIT: 'Break exit',
  PRODUCTION: 'Production',
  WAREHOUSE: 'Warehouse',
  SECURE_AREA: 'Secure area',
};

export const PURPOSE_TONE: Record<string, string> = {
  ENTRY: B.blue,
  EXIT: B.purple,
  ATTENDANCE: B.green,
  BREAK_ENTRY: B.progress,
  BREAK_EXIT: B.amber,
  PRODUCTION: B.hold,
  WAREHOUSE: B.neutral,
  SECURE_AREA: B.critical,
};

export const DEVICE_STATUS_LABEL: Record<string, string> = {
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  WARNING: 'Warning',
  MAINTENANCE: 'Maintenance',
  DISABLED: 'Disabled',
};

export const DEVICE_STATUS_TONE: Record<string, string> = {
  ONLINE: B.green,
  OFFLINE: B.neutral,
  WARNING: B.amber,
  MAINTENANCE: B.hold,
  DISABLED: B.neutral,
};

export const RAW_STATUS_TONE: Record<string, string> = {
  RECEIVED: B.blue,
  QUEUED: B.progress,
  PROCESSING: B.progress,
  PROCESSED: B.green,
  DUPLICATE: B.amber,
  FAILED: B.red,
  REJECTED: B.neutral,
};

export const EXCEPTION_STATUS_TONE: Record<string, string> = {
  OPEN: B.blue,
  ASSIGNED: B.progress,
  REVIEWING: B.amber,
  RESOLVED: B.green,
  APPROVED: B.green,
  REJECTED: B.red,
};

export const SEVERITY_TONE: Record<string, string> = {
  INFO: B.blue,
  WARN: B.amber,
  ERROR: B.red,
  CRITICAL: B.critical,
};

export const ATT_STATUS_TONE: Record<string, string> = {
  PRESENT: B.green,
  LATE: B.amber,
  EARLY_DEPARTURE: B.amber,
  HALF_DAY: B.progress,
  ABSENT: B.red,
  ON_LEAVE: B.purple,
  HOLIDAY: B.neutral,
  PENDING: B.amber,
  EXCUSED: B.blue,
};

export const APPROVAL_STATUS_TONE: Record<string, string> = {
  DRAFT: B.neutral,
  SUBMITTED: B.amber,
  APPROVED: B.green,
  REJECTED: B.red,
  ADJUSTED: B.blue,
};

export const PERIOD_STATUS_TONE: Record<string, string> = {
  OPEN: B.blue,
  PENDING_APPROVAL: B.amber,
  APPROVED: B.green,
  LOCKED: B.critical,
};

export const VERIF_LABEL: Record<string, string> = {
  FACE: 'Face recognition',
  CARD: 'Card',
  FINGERPRINT: 'Fingerprint',
  PASSWORD: 'Password',
  QR: 'QR code',
  UNKNOWN: 'Unknown',
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  CHECK_IN: 'Check in',
  CHECK_OUT: 'Check out',
  BREAK_START: 'Break start',
  BREAK_END: 'Break end',
  ACCESS_GRANTED: 'Access granted',
  ACCESS_DENIED: 'Access denied',
  UNKNOWN: 'Unknown',
};

export const EXCEPTION_TYPE_LABEL: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'Unknown employee',
  UNMAPPED_DEVICE: 'Unmapped device',
  DUPLICATE_PUNCH: 'Duplicate punch',
  MISSING_CHECK_IN: 'Missing check in',
  MISSING_CHECK_OUT: 'Missing check out',
  LATE_ARRIVAL: 'Late arrival',
  EARLY_DEPARTURE: 'Early departure',
  DEVICE_OFFLINE: 'Device offline',
  INVALID_TIMESTAMP: 'Invalid timestamp',
  REPLAY_EVENT: 'Replay event',
  SHIFT_CONFLICT: 'Shift conflict',
  PERIOD_LOCKED: 'Period locked',
  OTHER: 'Other',
};

export function fmtStatusLabel(v: unknown, fallback: Record<string, string> = {}): string {
  const raw = toStr(v);
  if (!raw) return '-';
  const up = raw.toUpperCase();
  if (fallback[up]) return fallback[up];
  return raw.replace(/_/g, ' ');
}

export function fmtTone(v: unknown, map: Record<string, string>): string {
  return map[toStr(v).toUpperCase()] ?? B.neutral;
}

export function Pill({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={'badge ' + tone} title={title}>
      {children}
    </span>
  );
}

export function DotPill({ tone, label }: { tone: string; label: string }) {
  return (
    <Pill tone={tone}>
      <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
      {label}
    </Pill>
  );
}

export function statusPill(value: unknown, map: Record<string, string>, labels?: Record<string, string>): ReactNode {
  const raw = toStr(value);
  if (!raw) return <span className="muted">-</span>;
  return <DotPill tone={fmtTone(raw, map)} label={fmtStatusLabel(raw, labels)} />;
}

export function purposePill(v: unknown): ReactNode {
  const raw = toStr(v).toUpperCase();
  if (!raw) return <span className="muted">-</span>;
  return <DotPill tone={PURPOSE_TONE[raw] ?? B.neutral} label={PURPOSE_LABEL[raw] ?? raw} />;
}

export function verifPill(v: unknown): ReactNode {
  const raw = toStr(v).toUpperCase();
  if (!raw) return <span className="muted">-</span>;
  return <DotPill tone={B.blue} label={VERIF_LABEL[raw] ?? raw.replace(/_/g, ' ')} />;
}

export function empName(e: Rec | null | undefined): string {
  if (!e) return 'Unknown employee';
  const n = toStr(pick(e, 'name'));
  if (n) return n;
  const f = toStr(pick(e, 'firstName', 'first_name'));
  const l = toStr(pick(e, 'lastName', 'last_name'));
  const joined = [f, l].filter(Boolean).join(' ').trim();
  return joined || 'Unknown employee';
}

export function empNo(e: Rec | null | undefined): string {
  if (!e) return '';
  return toStr(pick(e, 'employeeNo', 'employee_number', 'employeeNoString', 'employeeNumber'));
}

export function avatarHue(name: string): number {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

const AVATAR_TONES = ['#8B5CF6', '#1261A0', '#0891B2', '#168A5B', '#D97706', '#C93636', '#4F46A5', '#2878D0'];

export function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MiniAvatar({ name }: { name: string }) {
  const bg = AVATAR_TONES[Math.floor((avatarHue(name) / 360) * AVATAR_TONES.length)];
  return (
    <span className="avatar avatar-sm" style={{ background: bg }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function fmtClock(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '-';
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDay(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '-';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString('en-UG');
}

export function fmtWhen(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '-';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('en-UG', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function durLabel(mins: unknown): string {
  const m = toNum(mins, -1);
  if (m < 0) return '-';
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  if (h <= 0) return rest + 'm';
  return h + 'h ' + rest + 'm';
}

export function HikHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="hr">Hikvision Biometric Attendance</p>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </header>
  );
}

export function HikTabs({ active }: { active: string }) {
  const { user } = useAuth();
  const tabs: { id: string; label: string; href: string; perm: string }[] = [
    { id: 'live', label: 'Live', href: '/hikvision', perm: 'hikvision.dashboard.view' },
    { id: 'devices', label: 'Devices', href: '/hikvision/devices', perm: 'hikvision.devices.view' },
    { id: 'events', label: 'Events', href: '/hikvision/events', perm: 'hikvision.events.view' },
    { id: 'failed', label: 'Failed Events', href: '/hikvision/events/failed', perm: 'hikvision.events.view' },
    { id: 'exceptions', label: 'Exceptions', href: '/hikvision/exceptions', perm: 'hikvision.exceptions.view' },
    { id: 'attendance', label: 'Attendance', href: '/hikvision/attendance', perm: 'hr.attendance.view' },
    { id: 'health', label: 'Health', href: '/hikvision/health', perm: 'hikvision.health.view' },
    { id: 'sync', label: 'Sync', href: '/hikvision/sync', perm: 'hikvision.sync.view' },
    { id: 'reports', label: 'Reports', href: '/hikvision/reports', perm: 'hr.attendance.view' },
  ].filter((t) => can(user, t.perm));
  return (
    <div className="hk-tabs" role="tablist" aria-label="Hikvision attendance">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={'tab' + (t.id === active ? ' active' : '')}
          onClick={() => navigate(t.href)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function hkApiError(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed';
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function exportCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, filename.replace(/\.csv$/i, '') + '.csv');
}

export function exportXls(filename: string, title: string, headers: string[], rows: unknown[][]): void {
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>' +
    '<h3>' + esc(title) + '</h3><table border="1">' +
    '<tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</table></body></html>';
  const blob = new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  triggerDownload(blob, filename.replace(/\.xls$/i, '') + '.xls');
}

export function printReport(title: string, subtitle: string, headers: string[], rows: unknown[][]): void {
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const w = window.open('', '_blank', 'width=1100,height=760');
  if (!w) throw new Error('Popup blocked - allow popups to print reports.');
  w.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<style>body{font-family:Segoe UI,Arial,sans-serif;color:#1f2937;margin:24px}' +
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;font-weight:400;color:#6b7280;margin:0 0 16px}' +
    'table{border-collapse:collapse;width:100%;font-size:12px}' +
    'th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left;vertical-align:top}' +
    'th{background:#f3f4f6}@media print{body{margin:8mm}}</style></head><body>' +
    '<h1>' + esc(title) + '</h1><h2>' + esc(subtitle) + '</h2>' +
    '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></body></html>'
  );
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 350);
}
