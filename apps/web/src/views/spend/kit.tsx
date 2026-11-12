import { useState, type ReactNode } from 'react';
import { api, fmtDate, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { Badge } from '../../components/ui';

export type Rec = Record<string, unknown>;

export function num(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isoDay(v: unknown): string {
  if (!v) return '';
  const str = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function fmtDay(v: unknown): string {
  const d = isoDay(v);
  if (!d) return fmtDate(v);
  const [y, mo, day] = d.split('-').map(Number);
  return `${String(day).padStart(2, '0')} ${DAY_MONTHS[mo - 1]} ${y}`;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function personName(row: Rec): string {
  const name = `${s(row.firstName)} ${s(row.lastName)}`.trim();
  return name || s(row.requesterName) || s(row.createdByName) || 'Unknown';
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function RiskBadge({ row }: { row: Rec }) {
  const level = s(row.riskLevel);
  if (!level) return null;
  const tone = level === 'CRITICAL' ? 'badge-danger' : level === 'HIGH' ? 'badge-danger' : level === 'MEDIUM' ? 'badge-amber' : '';
  return (
    <span className={`badge ${tone}`}>
      {level === 'CRITICAL' || level === 'HIGH' ? '⚠ ' : ''}
      {level.replace(/_/g, ' ')}
    </span>
  );
}

export const SPEND_TABS: [string, string][] = [
  ['board', 'Command Center'],
  ['requisitions', 'Requisitions'],
  ['expenses', 'My Expenses'],
  ['petty-cash', 'Petty Cash'],
  ['claims', 'Expense Claims'],
  ['close', 'Daily Close'],
  ['payments', 'Payment Requests'],
  ['approvals', 'Expense Management'],
  ['reports', 'Reports'],
  ['policies', 'Policies'],
];

export function SpendTabs({ active }: { active: string }) {
  const { user } = useAuth();
  return (
    <nav className="spend-tabs" aria-label="Spend sections">
      {SPEND_TABS.filter(([key]) => key !== 'payments' || can(user, 'expenditure.payments.view'))
        .filter(([key]) => key !== 'approvals' || can(user, 'expenditure.expenses.view'))
        .filter(([key]) => key !== 'reports' || can(user, 'expenditure.reports.view'))
        .filter(([key]) => key !== 'policies' || can(user, 'expenditure.settings.view'))
        .map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={'spend-tab' + (active === key ? ' is-on' : '')}
          onClick={() => navigate(key === 'board' ? '/spend' : '/spend/' + key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export function SpendShell({
  title,
  blurb,
  active,
  actions,
  children,
}: {
  title: string;
  blurb?: string;
  active: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const crumb = SPEND_TABS.find(([key]) => key === active)?.[1] ?? title;
  return (
    <div className="page spend-page">
      <div className="crumbs">
        <button type="button" className="crumb-link" onClick={() => navigate('/spend')}>
          Requisitions & Spend
        </button>
        {active !== 'board' && (
          <>
            <span className="crumb-sep">/</span>
            <span>{crumb}</span>
          </>
        )}
      </div>
      <header className="page-head">
        <div>
          <div className="mod-kicker" data-mod="fin">Requisitions & Spend</div>
          <h1>{title}</h1>
          {blurb ? <p className="muted" style={{ margin: '6px 0 0', maxWidth: 640 }}>{blurb}</p> : null}
        </div>
        {actions ? <div className="head-actions">{actions}</div> : null}
      </header>
      <SpendTabs active={active} />
      {children}
    </div>
  );
}

export function StatusFilter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="search-input" style={{ width: 'auto', maxWidth: 220 }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All statuses</option>
      {options.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
    </select>
  );
}

export function MetaCard({ title, rows }: { title?: string; rows: [string, unknown][] }) {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  if (!filled.length) return null;
  return (
    <section className="card">
      {title && <div className="card-head"><h3>{title}</h3></div>}
      <dl className="detail-list">
        {filled.map(([k, v]) => (
          <div className="detail-row" key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Pipeline({ steps, status }: { steps: string[]; status: string }) {
  const idx = Math.max(0, steps.indexOf(status));
  const known = steps.includes(status);
  return (
    <ol className="pipeline">
      {steps.map((step, i) => (
        <li key={step} className={`pipeline-step ${known && i <= idx ? 'done' : ''} ${known && i === idx ? 'current' : ''}`}>
          <span className="pipeline-dot">{i + 1}</span>
          <span>{step.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ol>
  );
}

/** Upload a receipt image/file against an existing expense/claim/reference. */
export async function uploadReceiptInput(file: File | undefined, refType: string, refId: number): Promise<Rec> {
  if (!file) throw new Error('Choose a file first');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('refType', refType);
  fd.append('refId', String(refId));
  const r = await api<{ data: Rec }>('/api/ops/expenditure/receipts', { method: 'POST', body: fd });
  return r.data;
}

export function ReceiptChips({ receipts }: { receipts: Rec[] }) {
  if (!receipts.length) return <p className="empty-state">No receipts attached yet.</p>;
  return (
    <div className="related-list">
      {receipts.map((r) => (
        <div key={s(r.id)} className="related-item" style={{ alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{s(r.fileName)}</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {s(r.supplier) || 'Unknown supplier'}{r.invoiceNo ? ` · INV ${s(r.invoiceNo)}` : ''}
          </span>
          {num(r.total) > 0 && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtMoney(num(r.total))}</span>}
          <OcrBadge row={r} />
          {r.verified === true || r.verified === 'true' ? <Badge value="VERIFIED" /> : <Badge value="UNVERIFIED" />}
        </div>
      ))}
    </div>
  );
}

/** OCR extraction lifecycle for a receipt, kept separate from the verify flag. */
export function OcrBadge({ row }: { row: Rec }) {
  const st = s(row.ocrStatus);
  if (!st) return null;
  const tone = st === 'EXTRACTED' ? 'badge-green' : st === 'FAILED' ? 'badge-red' : st === 'PENDING' ? 'badge-amber' : 'badge-neutral';
  const icon = st === 'EXTRACTED' ? '✓' : st === 'FAILED' ? '✕' : st === 'PENDING' ? '⚠' : '●';
  const label = st === 'EXTRACTED' ? 'OCR' : st === 'PENDING' ? 'OCR PENDING' : st === 'FAILED' ? 'OCR FAILED' : st;
  return (
    <span className={`badge ${tone}`} title={`OCR status: ${st}`}>
      <span className="badge-icon" aria-hidden>{icon}</span>
      {label}
    </span>
  );
}
