import type { ReactNode } from 'react';
import { navigate } from '../router';
import { fmtMoney, fmtNum, getToken } from '../api';

export type Rec = Record<string, unknown>;

export function tileStyle(accent: string, tint: string): React.CSSProperties {
  return { '--tile-accent': accent, '--tile-tint': tint } as React.CSSProperties;
}

export function DefSec({ icon, title, sub, children }: { icon?: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card def-sec">
      <div className="def-sec-head">
        {icon && <span className="def-sec-icon" aria-hidden>{icon}</span>}
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      <dl className="def-list">{children}</dl>
    </section>
  );
}

export function DefRow({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={mono ? 'td-cell-mono' : undefined}>{v}</dd>
    </div>
  );
}

export function MiniBars({ rows, money }: { rows: Array<{ label: string; value: number }>; money?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = money ? fmtMoney : fmtNum;
  return (
    <div className="mini-bars">
      {rows.map((r) => (
        <div key={r.label} className="mini-bar">
          <span className="mini-bar-label" title={r.label}>{r.label}</span>
          <div className="mini-bar-track">
            {r.value > 0 && <div className="mini-bar-fill" style={{ width: String(Math.max(4, Math.round((r.value / max) * 100))) + '%' }} />}
          </div>
          <span className="mini-bar-value">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartCard({ title, rows, money }: { title: string; rows: Array<{ label: string; value: number }>; money?: boolean }) {
  return (
    <section className="card card-pad">
      <div className="card-head"><h3>{title}</h3></div>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No data yet.</p> : <MiniBars rows={rows} money={money} />}
    </section>
  );
}

export const ASSET_TABS: Array<[string, string, string]> = [
  ['board', 'Dashboard', '/assets'],
  ['register', 'Register', '/assets/register'],
  ['scan', 'Scanner', '/assets/scan'],
  ['verify', 'Verification', '/assets/verify'],
  ['tags', 'Tags', '/assets/tags'],
  ['custody', 'Custodians', '/assets/custody'],
  ['transfers', 'Transfers', '/assets/transfers'],
  ['audits', 'Audits', '/assets/audits'],
  ['maintenance', 'Maintenance', '/assets/maintenance'],
  ['depreciation', 'Depreciation', '/assets/depreciation'],
  ['impairments', 'Impairment', '/assets/impairments'],
  ['disposals', 'Disposal', '/assets/disposals'],
  ['anomalies', 'Anomalies', '/assets/anomalies'],
  ['import', 'Import', '/assets/import'],
  ['export', 'Export', '/assets/export'],
];

export function AssetModuleTabs({ active }: { active: string }) {
  return (
    <div className="tabs">
      {ASSET_TABS.map(([k, label, href]) => (
        <button key={k} className={k === active ? 'tab active' : 'tab'} onClick={() => navigate(href)}>{label}</button>
      ))}
    </div>
  );
}

export function ModuleHeader({ kicker: _kicker, title, sub, actions }: { kicker: string; title: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="ast">Asset management</p>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ maxWidth: 860 }}>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

export function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function labelize(v: unknown): string {
  return s(v).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function apiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(path, { ...init, headers });
}

export async function downloadBlob(path: string, fallbackName: string): Promise<void> {
  const res = await apiRaw(path);
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      msg = body?.error?.message ?? msg;
    } catch { /* not json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const m = disposition.match(/filename="?([^";]+)"?/i);
  const name = m ? m[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
