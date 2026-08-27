import type { CSSProperties, ReactNode } from 'react';

type Rec = Record<string, unknown>;

export function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarHue(name: string): number {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

const AVATAR_TONES = ['#8B5CF6', '#1261A0', '#0891B2', '#168A5B', '#D97706', '#C93636', '#4F46A5', '#2878D0'];

export function Avatar({ name, sub, size = 'md', meta = true }: { name: string; sub?: string; size?: 'sm' | 'md' | 'lg'; meta?: boolean }) {
  const bg = AVATAR_TONES[Math.floor((avatarHue(name) / 360) * AVATAR_TONES.length)];
  return (
    <span className="avatar-row" style={{ minWidth: 0 }}>
      <span className={'avatar avatar-' + size} style={{ background: bg }} aria-hidden>{initials(name)}</span>
      {meta && (name || sub) && (
        <span className="avatar-meta">
          {name && <span className="avatar-name">{name}</span>}
          {sub && <span className="avatar-sub">{sub}</span>}
        </span>
      )}
    </span>
  );
}

export function HrEmptyState({ icon = '•', title, hint, children }: { icon?: string; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

/** Centered empty row inside a <table>. */
export function HrTableEmpty({ colSpan, icon = '•', title, hint }: { colSpan: number; icon?: string; title: string; hint?: string }) {
  return (
    <tr>
      <td colSpan={colSpan}>
        <div className="empty-state" style={{ padding: '26px 16px' }}>
          <div className="empty-icon" aria-hidden>{icon}</div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
      </td>
    </tr>
  );
}

export function HrPageHeader({ kicker, title, subtitle, actions }: { kicker: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="hr">{kicker}</p>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

export function HrToolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function tileStyle(accent: string, tint: string): CSSProperties {
  return { ['--tile-accent' as string]: accent, ['--tile-tint' as string]: tint };
}

export function HrKpiGrid({ children }: { children: ReactNode }) {
  return <div className="kpi-grid">{children}</div>;
}

export function HrKpi({ label, value, sub, accent = 'var(--mod-hr)', tint = 'rgba(139, 92, 246, 0.12)' }: { label: string; value: ReactNode; sub?: string; accent?: string; tint?: string }) {
  return (
    <div className="kpi-tile" style={tileStyle(accent, tint)}>
      <span className="kpi-tile-icon" aria-hidden>◈</span>
      <span className="kpi-tile-body">
        <span className="kpi-tile-label">{label}</span>
        <span className="kpi-tile-value">{value}</span>
        {sub && <span className="kpi-tile-sub">{sub}</span>}
      </span>
    </div>
  );
}

/** Compact "code" chip used in org charts and position lists. */
export function CodeChip({ children }: { children: ReactNode }) {
  return <span className="cell-mono chip-chip">{children}</span>;
}

/** Small labelled count bubble, e.g. headcount per node. */
export function CountChip({ value, title }: { value: unknown; title?: string }) {
  return <span className="org-count" title={title}>{String(value ?? 0)}</span>;
}

export function employeeIdOf(e: Rec): string {
  const v = e.employeeNumber ?? e.employeeNo ?? e.shortEmployeeNumber ?? e.badgeNumber ?? '';
  return v === null || v === undefined ? '' : String(v);
}

export function fullNameOf(e: Rec): string {
  const a = String(e.firstName ?? e.first_name ?? '');
  const b = String(e.lastName ?? e.last_name ?? '');
  return (a + ' ' + b).trim();
}
