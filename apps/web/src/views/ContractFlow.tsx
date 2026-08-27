import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate, currentQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager, Spinner, StaffPhoto } from '../components/ui';

type Rec = Record<string, unknown>;

const CONTRACT_TYPES = ['PERMANENT', 'FIXED_TERM', 'PROBATIONARY', 'PART_TIME', 'TEMPORARY', 'APPRENTICESHIP', 'CASUAL', 'INTERNSHIP', 'CONSULTANCY', 'SECONDMENT', 'OTHER'];

const CONTRACT_TYPE_INFO: Record<string, { desc: string; note: string; employment: boolean }> = {
  PERMANENT: { employment: true, desc: 'Open-ended employment with no set end date.', note: 'Permanent employment is the default form. Notice, leave and other statutory rights under the Employment Act apply in full.' },
  FIXED_TERM: { employment: true, desc: 'Employment for a stated period or task.', note: 'Fixed-term contracts should state the reason and end date. Notice provisions still apply, and consecutive renewals may have legal consequences.' },
  PROBATIONARY: { employment: true, desc: 'Initial period to assess suitability.', note: 'Probation must comply with statutory limits and cannot remove notice or any other statutory employment right.' },
  PART_TIME: { employment: true, desc: 'Fewer hours than a full-time equivalent.', note: 'Part-time employees retain their statutory rights; record hours, pay and leave accurately.' },
  TEMPORARY: { employment: true, desc: 'Time-bound employment for a specific task.', note: 'Temporary employees remain employees under the Act and keep their statutory entitlements.' },
  APPRENTICESHIP: { employment: true, desc: 'Structured training in a trade or profession.', note: 'Apprenticeship arrangements must meet the applicable legal requirements for apprentices.' },
  CASUAL: { employment: true, desc: 'Irregular or as-needed work.', note: 'Casual workers may still qualify as employees under the Act; record hours and pay accurately.' },
  INTERNSHIP: { employment: true, desc: 'Work experience with a learning focus.', note: 'Confirm whether the intern is an employee or trainee - statutory rights may still apply.' },
  CONSULTANCY: { employment: false, desc: 'Independent services, not employment.', note: 'Consultants and contractors are not employees under the Employment Act. A services agreement may be more appropriate than an employment contract.' },
  SECONDMENT: { employment: true, desc: 'Temporary assignment to another entity.', note: 'The employment relationship continues during a secondment; document the host arrangement and who remains the employer.' },
  OTHER: { employment: true, desc: 'Another approved arrangement.', note: 'Legal review is recommended for arrangements that do not fit a standard category.' },
};
const SALARY_FREQUENCIES = ['MONTHLY', 'WEEKLY', 'FORTNIGHTLY', 'HOURLY', 'DAILY', 'ANNUAL'];
const CURRENCIES = ['UGX', 'USD', 'KES', 'GBP', 'EUR'];
const VARIATION_TYPES = ['SALARY', 'JOB_TITLE', 'DEPARTMENT_TRANSFER', 'WORKPLACE_TRANSFER', 'WORKING_HOURS', 'ALLOWANCE', 'BENEFITS', 'PROMOTION', 'DEMOTION', 'REPORTING_LINE', 'CONTRACT_EXTENSION', 'CONTRACT_RENEWAL', 'OTHER'];
const ALLOWANCE_TYPES = ['HOUSING', 'TRANSPORT', 'AIRTIME', 'RESPONSIBILITY', 'MEDICAL', 'MEAL', 'TRAVEL', 'COMMUNICATION', 'RISK', 'SHIFT', 'ACTING', 'OTHER'];
const BENEFIT_TYPES = ['MEDICAL_INSURANCE', 'PENSION', 'LIFE_INSURANCE', 'STAFF_LOAN', 'COMPANY_VEHICLE', 'HOUSING', 'TELEPHONE', 'INTERNET', 'OTHER'];
const SIGNER_TYPES = ['EMPLOYEE', 'EMPLOYER_REPRESENTATIVE', 'WITNESS'];
const CLAUSE_CATEGORIES = ['Employment', 'Job Duties', 'Salary', 'Allowances', 'Working Hours', 'Overtime', 'Leave', 'Rights', 'Probation', 'Confidentiality', 'Intellectual Property', 'Data Protection', 'Company Property', 'IT Acceptable Use', 'Cybersecurity', 'Conflict of Interest', 'Non-Solicitation', 'Disciplinary Matters', 'Health & Safety', 'Workplace Conduct', 'Anti-Bribery', 'Anti-Fraud', 'Termination', 'Notice', 'Redundancy', 'Grievance', 'Dispute Resolution', 'Applicable Law', 'General'];

function contractTypeLabel(t: string): string {
  const m: Record<string, string> = {
    PERMANENT: 'Permanent', FIXED_TERM: 'Fixed Term', PROBATIONARY: 'Probationary', PART_TIME: 'Part Time',
    TEMPORARY: 'Temporary', APPRENTICESHIP: 'Apprenticeship', CASUAL: 'Casual', INTERNSHIP: 'Internship',
    CONSULTANCY: 'Consultancy', SECONDMENT: 'Secondment', RENEWAL: 'Renewal', VARIATION: 'Variation',
    PROMOTION: 'Promotion', TRANSFER: 'Transfer', SALARY_ADJUSTMENT: 'Salary Adjustment', OTHER: 'Other',
  };
  return m[t] ?? t;
}

function variationLabel(t: string): string {
  const m: Record<string, string> = {
    SALARY: 'Salary', JOB_TITLE: 'Job title', DEPARTMENT_TRANSFER: 'Department transfer',
    WORKPLACE_TRANSFER: 'Workplace transfer', WORKING_HOURS: 'Working hours', ALLOWANCE: 'Allowance',
    BENEFITS: 'Benefits', PROMOTION: 'Promotion', DEMOTION: 'Demotion', REPORTING_LINE: 'Reporting line',
    CONTRACT_EXTENSION: 'Contract extension', CONTRACT_RENEWAL: 'Contract renewal', OTHER: 'Other',
  };
  return m[t] ?? t;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

const TYPE_TONES: Record<string, string> = {
  PERMANENT: 'badge-green',
  FIXED_TERM: 'badge-blue',
  PROBATIONARY: 'badge-amber',
  PART_TIME: 'badge-teal',
  TEMPORARY: 'badge-purple',
  APPRENTICESHIP: 'badge-info',
  CASUAL: 'badge-neutral',
  INTERNSHIP: 'badge-info',
  CONSULTANCY: 'badge-warn',
  SECONDMENT: 'badge-progress',
  OTHER: 'badge-neutral',
};

function typeChip(t: string): ReactNode {
  return <span className={'badge ' + (TYPE_TONES[t] ?? 'badge-neutral')}>{contractTypeLabel(t)}</span>;
}

function fmtD(v: unknown): string {
  if (!v) return '-';
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtUGX(v: unknown, currency?: unknown): string {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (isNaN(n)) return '-';
  const cur = currency ? String(currency).toUpperCase() : 'UGX';
  return cur + ' ' + n.toLocaleString('en-UG', { maximumFractionDigits: 0 });
}

function daysUntil(v: unknown): number | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}

function downloadCsv(filename: string, rows: string[][]): void {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function employeeName(e: Rec): string {
  return String(e.firstName ?? e.first_name ?? '') + ' ' + String(e.lastName ?? e.last_name ?? '');
}

function termBody(t: Rec): string {
  const v = t.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Rec;
    if (o.text) return String(o.text);
    if (o.value) return String(o.value);
  }
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (t.description) return String(t.description);
  if (t.body) return String(t.body);
  return '';
}

function templateContentSections(v: Rec): Array<{ sectionCode: string; clauses: string[] }> {
  const raw = parseJson<unknown>(v.content, []);
  if (!Array.isArray(raw)) return [];
  const out: Array<{ sectionCode: string; clauses: string[] }> = [];
  for (const item of raw) {
    const o = (item ?? {}) as Rec;
    const clauses = Array.isArray(o.clauses) ? (o.clauses as unknown[]).map((c) => String(c)) : [];
    out.push({ sectionCode: String(o.section_code ?? ''), clauses });
  }
  return out;
}

function templateVersionSections(v: Rec): Array<{ sectionCode: string; clauses: string[] }> {
  const fromContent = templateContentSections(v);
  if (fromContent.length > 0) return fromContent;
  const raw = parseJson<unknown>(v.sections, []);
  if (!Array.isArray(raw)) return [];
  const out: Array<{ sectionCode: string; clauses: string[] }> = [];
  for (const item of raw) {
    const o = (item ?? {}) as Rec;
    const clauses = Array.isArray(o.clauses) ? (o.clauses as unknown[]).map((c) => String(c)) : [];
    out.push({ sectionCode: String(o.section_code ?? o.sectionCode ?? ''), clauses });
  }
  return out;
}

// ============================================================
// Contract module UI helpers (modern command-centre design)
// ============================================================
function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return h % 360;
}

const AVATAR_TONES = ['#8B5CF6', '#1261A0', '#0891B2', '#168A5B', '#D97706', '#C93636', '#4F46A5', '#2878D0'];

function Avatar({ name, sub, size = 'md' }: { name: string; sub?: string; size?: 'sm' | 'md' | 'lg' }) {
  const hue = avatarHue(name);
  const bg = AVATAR_TONES[Math.floor((hue / 360) * AVATAR_TONES.length)];
  return (
    <span className="avatar-row" style={{ minWidth: 0 }}>
      <span className={'avatar avatar-' + size} style={{ background: bg }} aria-hidden>{initials(name)}</span>
      {(name || sub) && (
        <span className="avatar-meta">
          {name && <span className="avatar-name">{name}</span>}
          {sub && <span className="avatar-sub">{sub}</span>}
        </span>
      )}
    </span>
  );
}

function EmptyState({ icon = '•', title, hint, children }: { icon?: string; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

function LoadingRow({ label = 'Loading…', colSpan = 7 }: { label?: string; colSpan?: number }) {
  return (
    <tr>
      <td colSpan={colSpan}>
        <div className="table-loading" role="status">
          <Spinner />
          <span>{label}</span>
        </div>
      </td>
    </tr>
  );
}

function tileStyle(accent: string, tint: string): React.CSSProperties {
  return { '--tile-accent': accent, '--tile-tint': tint } as React.CSSProperties;
}

function DefSec({ icon, title, sub, children }: { icon?: string; title: string; sub?: string; children: ReactNode }) {
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

function DefRow({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={mono ? 'td-cell-mono' : undefined}>{v}</dd>
    </div>
  );
}

const LIFECYCLE: Array<[string, string[]]> = [
  ['Draft', ['DRAFT', 'VALIDATING']],
  ['Approval', ['SUBMITTED', 'HR_REVIEW', 'MANAGER_REVIEW', 'FINANCE_REVIEW', 'LEGAL_REVIEW', 'APPROVED']],
  ['Signature', ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED']],
  ['Executed', ['EXECUTED']],
  ['Active', ['ACTIVE', 'VARIED', 'RENEWED']],
];

function lifecycleIndex(status: string): number {
  const i = LIFECYCLE.findIndex(([, states]) => states.includes(status));
  return i === -1 ? 0 : i;
}

function lifecycleTerminal(status: string): { kind: 'ended' | 'archived' | 'rejected'; label: string } | null {
  if (status === 'EXPIRED' || status === 'TERMINATED') return { kind: 'ended', label: 'This contract has ended (' + status.replace(/_/g, ' ').toLowerCase() + '). The executed document is preserved for evidence.' };
  if (status === 'ARCHIVED') return { kind: 'archived', label: 'This contract is archived. The executed document remains immutable.' };
  if (status === 'REJECTED') return { kind: 'rejected', label: 'This contract was rejected in the approval workflow. Reopen and correct before resubmitting.' };
  return null;
}


const AUDIT_EVENTS: Array<{ key: string; icon: string; color: string }> = [
  { key: 'create', icon: '📄', color: '#1261A0' },
  { key: 'validate', icon: '🛡️', color: '#0891B2' },
  { key: 'submit', icon: '🚀', color: '#2878D0' },
  { key: 'send_for_signature', icon: '✉️', color: '#D97706' },
  { key: 'sign', icon: '✍️', color: '#168A5B' },
  { key: 'execute', icon: '✅', color: '#168A5B' },
  { key: 'update', icon: '✏️', color: '#4F46A5' },
  { key: 'variation', icon: '🔀', color: '#D97706' },
  { key: 'renewal', icon: '🔁', color: '#0891B2' },
  { key: 'certificate', icon: '📜', color: '#4F46A5' },
];

function auditEventMeta(action: string): { icon: string; color: string; label: string } {
  const hit = AUDIT_EVENTS.find((e) => action.includes(e.key));
  const base = hit ?? { icon: '•', color: '#8B5CF6' };
  const label = action
    .replace(/^contract\./, '')
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
  return { icon: base.icon, color: base.color, label: label || 'Event' };
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return 'rgba(139, 92, 246, ' + alpha + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

export default function ContractFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const id = parts[2] ?? null;
  const sub = parts[3] ?? null;
  if (id === 'list' || id === 'register') return <ContractList />;
  if (id === 'new') return <ContractComposer />;
  if (id === 'templates') return sub ? <TemplateDesk id={Number(sub)} /> : <TemplateList />;
  if (id === 'clauses') return <ClauseLibrary />;
  if (id === 'legal-rules') return <LegalRules />;
  if (id === 'expiring') return <SmartList kind="expiring" />;
  if (id === 'probation-ending') return <SmartList kind="probation" />;
  if (id === 'missing-particulars') return <MissingParticulars />;
  if (id === 'my') return <MyContracts />;
  if (id === 'certificates') return <Certificates />;
  if (id) return <ContractDesk id={Number(id)} />;
  return <ContractBoard />;
}

function ModuleTabs({ active }: { active: string }) {
  const tabs: Array<[string, string, string]> = [
    ['board', 'Board', '/people/contracts'],
    ['list', 'Register', '/people/contracts/list'],
    ['expiring', 'Expiring', '/people/contracts/expiring'],
    ['probation', 'Probation', '/people/contracts/probation-ending'],
    ['missing', 'Missing info', '/people/contracts/missing-particulars'],
    ['templates', 'Templates', '/people/contracts/templates'],
    ['clauses', 'Clauses', '/people/contracts/clauses'],
    ['rules', 'Legal rules', '/people/contracts/legal-rules'],
    ['certificates', 'Certificates', '/people/contracts/certificates'],
  ];
  return (
    <div className="tabs">
      {tabs.map(([k, label, href]) => (
        <button key={k} className={k === active ? 'tab active' : 'tab'} onClick={() => navigate(href)}>{label}</button>
      ))}
    </div>
  );
}

function MiniBars({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="mini-bars">
      {rows.map((r) => (
        <div key={r.label} className="mini-bar">
          <span className="mini-bar-label" title={r.label}>{r.label}</span>
          <div className="mini-bar-track">
            {r.value > 0 && <div className="mini-bar-fill" style={{ width: String(Math.round((r.value / max) * 100)) + '%' }} />}
          </div>
          <span className="mini-bar-value">{fmtNum(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  return (
    <section className="card card-pad">
      <div className="card-head"><h3>{title}</h3></div>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No data yet.</p> : <MiniBars rows={rows} />}
    </section>
  );
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// ============================================================
// CONTRACT BOARD (dashboard + register)
// ============================================================

function ContractBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hr/contracts/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Contract board failed'));
    api<{ data: { items: Rec[] } }>('/api/ops/hr/contracts?pageSize=8')
      .then((r) => setRows(r.data.items ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key.toLowerCase() === 'n' && can(user, 'hr.contracts.create')) {
        e.preventDefault();
        navigate('/people/contracts/new');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening contracts" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const charts = (data.charts ?? {}) as Rec;
  const alerts = (data.alerts as string[]) ?? [];
  const byType = (charts.byType as Array<{ label: string; value: number }>) ?? [];
  const byStatus = (charts.byStatus as Array<{ label: string; value: number }>) ?? [];
  const byDepartment = (charts.byDepartment as Array<{ label: string; value: number }>) ?? [];
  const byBranch = (charts.byBranch as Array<{ label: string; value: number }>) ?? [];
  const expiryTrend = (charts.expiryTrend as Array<{ label: string; value: number }>) ?? [];
  const probationStatus = (charts.probationStatus as Array<{ label: string; value: number }>) ?? [];
  const kpiCards: Array<{ key: string; label: string; value: unknown; sub: string; href: string; icon: string; accent: string; tint: string }> = [
    { key: 'active', label: 'Active contracts', value: kpis.active, sub: 'Executed or active today', href: '/people/contracts?status=ACTIVE', icon: '✓', accent: '#168A5B', tint: 'rgba(22,138,91,0.12)' },
    { key: 'sig', label: 'Pending signature', value: kpis.pendingSignature, sub: 'Sent or partially signed', href: '', icon: '✎', accent: '#D99A00', tint: 'rgba(217,154,0,0.12)' },
    { key: 'approval', label: 'Awaiting approval', value: kpis.awaitingApproval, sub: 'In the approval workflow', href: '', icon: '◷', accent: '#2878D0', tint: 'rgba(40,120,208,0.12)' },
    { key: 'expiry', label: 'Expiring in 30 days', value: kpis.expiring30, sub: 'Fixed-term contracts', href: '/people/contracts/expiring', icon: '⏳', accent: '#D97706', tint: 'rgba(217,119,6,0.12)' },
    { key: 'prob', label: 'Probation ending', value: kpis.probationEnding30, sub: 'Within 30 days', href: '/people/contracts/probation-ending', icon: '●', accent: '#0891B2', tint: 'rgba(8,145,178,0.12)' },
    { key: 'missing', label: 'Missing particulars', value: kpis.missingParticulars, sub: 'Need completion', href: '/people/contracts/missing-particulars', icon: '!', accent: '#C93636', tint: 'rgba(201,54,54,0.12)' },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Employment contracts</h1>
          <p className="muted">Create, approve and sign Uganda employment contracts. Written particulars are validated against the Employment Act, 2006 (Chapter 226) before approval.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.contracts.create') && (
            <button className="btn btn-primary" onClick={() => navigate('/people/contracts/new')}>New contract</button>
          )}
          {can(user, 'hr.certificates.create') && (
            <button className="btn" onClick={() => navigate('/people/contracts/certificates')}>Certificate of service</button>
          )}
          <span className="kbd-hints" aria-hidden><kbd>n</kbd> new contract</span>
        </div>
      </header>

      <ModuleTabs active="board" />
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid--tiles">
        {kpiCards.map((k) => (
          <button key={k.key} className="kpi-tile" style={tileStyle(k.accent, k.tint)} disabled={!k.href} onClick={() => k.href && navigate(k.href)}>
            <span className="kpi-tile-icon" aria-hidden>{k.icon}</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">{k.label}</span>
              <span className="kpi-tile-value">{fmtNum(k.value)}</span>
              <span className="kpi-tile-sub">{k.sub}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="grid-3" style={{ marginTop: 16 }}>
        <ChartCard title="Contracts by type" rows={byType} />
        <ChartCard title="Contracts by status" rows={byStatus} />
        <ChartCard title="Contracts by department" rows={byDepartment} />
        <ChartCard title="Contracts by branch" rows={byBranch} />
        <ChartCard title="Contract expiry trend" rows={expiryTrend} />
        <ChartCard title="Probation status" rows={probationStatus} />
      </div>
      {alerts.length > 0 && (
        <section className="card card-pad" style={{ marginTop: 16 }}>
          <div className="card-head"><h3>Alerts</h3></div>
          <div className="stack" style={{ gap: 8 }}>
            {alerts.map((a, i) => (
              <div key={i} className="callout callout-warn" style={{ margin: 0, padding: '10px 14px' }}>
                <span className="callout-icon" aria-hidden>⚠</span>
                <div className="callout-body"><p style={{ margin: 0 }}>{a}</p></div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Recent contracts</h3>
          <button className="btn btn-sm" onClick={() => navigate('/people/contracts')}>Open register</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Contract</th><th>Employee</th><th>Type</th><th>Start</th><th>End</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
  const rEnd = r.endDate ? daysUntil(r.endDate) : null;
  const rPill = r.endDate && rEnd !== null && rEnd >= 0
    ? rEnd <= 30 ? <span className="pill pill-danger">{rEnd} days</span>
    : rEnd <= 90 ? <span className="pill pill-warn">{rEnd} days</span>
    : <span className="pill pill-ok">{rEnd} days</span>
    : null;
  return (
    <tr key={String(r.id)} className="row-click" onClick={() => navigate('/people/contracts/' + String(r.id))}>
      <td className="td-cell-mono">{String(r.contractNo ?? '-')}<span className="reg-version">{' v' + String(r.version ?? '1.0')}</span></td>
      <td><Avatar name={String(r.firstName ?? '') + ' ' + String(r.lastName ?? '')} sub={String(r.employeeNo ?? '') + (r.jobTitle ? '\u00B7 ' + String(r.jobTitle) : '')} size="sm" /></td>
      <td>{typeChip(String(r.contractType ?? ''))}</td>
      <td>{fmtD(r.startDate)}</td>
      <td><span className="expiry-cell">{fmtD(r.endDate)}{rPill}</span></td>
      <td><Badge value={r.status} /></td>
      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
        <span className="action-group">
          <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(r.id))}>Open</button>
          <button
            className="btn btn-sm"
            title="Print with all clauses"
            onClick={async () => {
              try {
                await openDocument('employment-contract', r.id, 'print', String(r.contractNo ?? 'contract') + '.pdf');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >Print</button>
        </span>
      </td>
    </tr>
  );
})}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// CONTRACT COMPOSER (wizard)
// ============================================================

const WEEK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

function ContractComposer() {
  const [step, setStep] = useState(1);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [templates, setTemplates] = useState<Rec[]>([]);
  const [clauses, setClauses] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [contractType, setContractType] = useState('PERMANENT');
  const [templateId, setTemplateId] = useState('');
  const [reason, setReason] = useState('');
  const [employmentTypeConfirmed, setEmploymentTypeConfirmed] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobCode, setJobCode] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [location, setLocation] = useState('');
  const [reportingManager, setReportingManager] = useState('');
  const [employeeCategory, setEmployeeCategory] = useState('');
  const [noticePeriodDays, setNoticePeriodDays] = useState('');
  const [noticeBasis, setNoticeBasis] = useState('STATUTORY');
  const [workingHoursPerWeek, setWorkingHoursPerWeek] = useState('40');
  const [workingDays, setWorkingDays] = useState<string[]>(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);
  const [restDays, setRestDays] = useState<string[]>(['SATURDAY', 'SUNDAY']);
  const [annualLeaveDays, setAnnualLeaveDays] = useState('21');
  const [expiryNotificationDate, setExpiryNotificationDate] = useState('');
  const [renewalEligibility, setRenewalEligibility] = useState(false);
  const [probStart, setProbStart] = useState('');
  const [probEnd, setProbEnd] = useState('');
  const [probDuration, setProbDuration] = useState('');
  const [basic, setBasic] = useState('');
  const [gross, setGross] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [frequency, setFrequency] = useState('MONTHLY');
  const [allowances, setAllowances] = useState<Rec[]>([]);
  const [benefits, setBenefits] = useState<Rec[]>([]);
  const [clauseCodes, setClauseCodes] = useState<string[]>([]);
  const [handlesPersonalData, setHandlesPersonalData] = useState(false);
  const [hasConfidentialAccess, setHasConfidentialAccess] = useState(false);
  const [overtimeEligible, setOvertimeEligible] = useState(false);
  const preselectEmployee = useMemo(() => currentQuery().get('employee') ?? '', []);

  const load = useCallback(() => {
    api<{ data: unknown }>('/api/ops/hr/employees?pageSize=200').then((r) => { const d = r.data as Rec | Rec[] | null; setEmployees(Array.isArray(d) ? d : (d && Array.isArray(d.rows) ? (d.rows as Rec[]) : [])); }).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hr/departments').then((r) => setDepts(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hr/contracts/templates').then((r) => setTemplates(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hr/contracts/clauses?pageSize=200').then((r) => setClauses(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (preselectEmployee) setEmployeeId(preselectEmployee);
  }, [preselectEmployee]);
  useEffect(() => {
    if (!employeeId) return;
    const emp = employees.find((e) => String(e.id) === String(employeeId));
    if (!emp) return;
    if (emp.position) setJobTitle(String(emp.position));
    setDepartmentId(emp.departmentId != null && emp.departmentId !== '' ? String(emp.departmentId) : '');
    if (emp.baseSalary != null && emp.baseSalary !== '') {
      setBasic(String(emp.baseSalary));
      setGross(String(emp.baseSalary));
    }
  }, [employeeId, employees]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const k = e.key.toLowerCase();
      if (e.altKey && k === 'arrowleft' && step > 1) { e.preventDefault(); setStep(step - 1); }
      else if (e.altKey && k === 'arrowright' && step < steps.length && canNext()) { e.preventDefault(); setStep(step + 1); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && step === steps.length && !!employeeId) { e.preventDefault(); create(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => {
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  };
  const pushAllowance = () => setAllowances([...allowances, { allowanceType: 'HOUSING', name: '', amount: '', percentage: '', frequency: 'MONTHLY', taxable: true }]);
  const patchAllowance = (i: number, k: string, v: unknown) => {
    const next = allowances.map((a, j) => (j === i ? { ...a, [k]: v } : a));
    setAllowances(next);
  };
  const pushBenefit = () => setBenefits([...benefits, { benefitType: 'MEDICAL_INSURANCE', name: '', employerCost: '', employeeContribution: '', frequency: 'MONTHLY', taxable: true }]);
  const patchBenefit = (i: number, k: string, v: unknown) => {
    const next = benefits.map((b, j) => (j === i ? { ...b, [k]: v } : b));
    setBenefits(next);
  };

  const steps: Array<[string, number, string]> = [
    ['Employee', 1, 'Who is being employed'],
    ['Employment', 2, 'Role, hours and statutory particulars'],
    ['Compensation', 3, 'Salary, allowances and benefits'],
    ['Clauses', 4, 'Terms selected from the clause library'],
    ['Review', 5, 'Confirm before creating the draft'],
  ];

  const canNext = (): boolean => {
    if (step === 1) return !!employeeId;
    if (step === 2) return !!startDate.trim() && (contractType !== 'FIXED_TERM' || !!endDate.trim());
    if (step === 4 && contractType === 'CONSULTANCY' && !employmentTypeConfirmed) return false;
    return true;
  };

  const nextHint = (): string => {
    if (step === 1 && !employeeId) return 'Select an employee to continue.';
    if (step === 2) {
      if (!startDate.trim()) return 'Enter the employment start date to continue.';
      if (contractType === 'FIXED_TERM' && !endDate.trim()) return 'Fixed-term contracts require an end date.';
    }
    if (step === 4 && contractType === 'CONSULTANCY' && !employmentTypeConfirmed) return 'Confirm the independent-contractor classification to continue.';
    return '';
  };

  const create = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const payload: Rec = {
        employeeId: Number(employeeId),
        contractType,
        startDate: startDate.trim(),
        jobTitle: jobTitle.trim() || undefined,
        jobCode: jobCode.trim() || undefined,
        departmentId: departmentId ? Number(departmentId) : undefined,
        location: location.trim() || undefined,
        reportingManager: reportingManager ? Number(reportingManager) : undefined,
        employeeCategory: employeeCategory.trim() || undefined,
        noticePeriodDays: noticePeriodDays ? Number(noticePeriodDays) : undefined,
        noticeBasis: noticeBasis || undefined,
        workingHoursPerWeek: workingHoursPerWeek ? Number(workingHoursPerWeek) : undefined,
        workingDays: workingDays.length ? workingDays : undefined,
        restDays: restDays.length ? restDays : undefined,
        annualLeaveDays: annualLeaveDays ? Number(annualLeaveDays) : undefined,
        currency: currency || undefined,
        grossSalary: gross ? Number(gross) : undefined,
        expiryNotificationDate: expiryNotificationDate || undefined,
        renewalEligibility: renewalEligibility || undefined,
        reason: reason.trim() || undefined,
        clauseCodes: clauseCodes.length ? clauseCodes : undefined,
        employmentTypeConfirmed: contractType === 'CONSULTANCY' ? employmentTypeConfirmed : undefined,
        handlesPersonalData: handlesPersonalData || undefined,
        hasConfidentialAccess: hasConfidentialAccess || undefined,
        overtimeEligible: overtimeEligible || undefined,
      };
      if (templateId) payload.templateId = Number(templateId);
      if (endDate.trim()) payload.endDate = endDate.trim();
      if (contractType === 'PROBATIONARY' || (probStart || probEnd || probDuration)) {
        payload.probation = {
          startDate: probStart || startDate || undefined,
          endDate: probEnd || undefined,
          durationDays: probDuration ? Number(probDuration) : undefined,
        };
      }
      if (basic || gross) {
        payload.salary = {
          basic: basic ? Number(basic) : undefined,
          gross: gross ? Number(gross) : undefined,
          currency: currency || undefined,
          frequency: frequency || undefined,
          allowances: allowances.length ? allowances.map((a) => ({
            allowanceType: String(a.allowanceType ?? ''),
            name: String(a.name ?? '').trim() || undefined,
            amount: a.amount ? Number(a.amount) : undefined,
            percentage: a.percentage ? Number(a.percentage) : undefined,
            frequency: String(a.frequency ?? 'MONTHLY') || undefined,
            taxable: a.taxable !== undefined ? Boolean(a.taxable) : undefined,
          })) : undefined,
          benefits: benefits.length ? benefits.map((b) => ({
            benefitType: String(b.benefitType ?? ''),
            name: String(b.name ?? '').trim() || undefined,
            employerCost: b.employerCost ? Number(b.employerCost) : undefined,
            employeeContribution: b.employeeContribution ? Number(b.employeeContribution) : undefined,
            frequency: String(b.frequency ?? 'MONTHLY') || undefined,
            taxable: b.taxable !== undefined ? Boolean(b.taxable) : undefined,
          })) : undefined,
        };
      }
      const r = await api<{ data: { contractId: number; contractNo: string; warnings: string[] } }>('/api/ops/hr/contracts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNotice('Contract ' + r.data.contractNo + ' created as draft');
      navigate('/people/contracts/' + String(r.data.contractId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const selectedEmployee = employees.find((e) => String(e.id) === employeeId);
  const selTemplate = templates.find((t) => String(t.id) === templateId);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/contracts')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Contract builder</p>
          <h1>New employment contract</h1>
          <p className="muted">Statutory written particulars (Employment Act, 2006, s.59) are validated before approval. The platform does not remove or reduce any statutory employment right.</p>
        </div>
      </header>
      {notice && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>✓</span>
          <div className="callout-body">
            <p style={{ color: 'var(--ink)' }}>{notice}</p>
          </div>
        </div>
      )}
      {error && <ErrorBanner error={error} />}
      {selectedEmployee && (
          <div className="composer-summary">
            <span className="composer-summary-label">Draft summary</span>
            <Avatar name={employeeName(selectedEmployee)} sub={String(selectedEmployee.employeeNo ?? '')} size="sm" />
            <span className="composer-summary-divider" aria-hidden="true" />
            {typeChip(contractType)}
            <span className="composer-summary-divider" aria-hidden="true" />
            <span className="composer-summary-template">{selTemplate ? String(selTemplate.name ?? '') : 'Default template for type'}</span>
          </div>
        )}
      <div className="cstepper" role="tablist" aria-label="Contract builder steps">
        {steps.map(([label, n]) => {
          const done = n < step;
          const current = n === step;
          return (
            <button key={String(n)} role="tab" aria-selected={current} className={'cstep' + (done ? ' done' : '') + (current ? ' current' : '') + (done ? ' clickable' : '')} onClick={() => done && setStep(n)}>
              <span className="cstep-dot" aria-hidden>{done ? '✓' : String(n)}</span>
              <span className="cstep-label">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="cstepper-track" aria-hidden><span style={{ width: Math.round(((step - 1) / (steps.length - 1)) * 100) + '%' }} /></div>
      <section className="card card-pad composer-pane" style={{ marginTop: 12 }}>
        <div className="composer-step-head">
          <div>
            <h2>{steps[step - 1]?.[0]}</h2>
            <p>{steps[step - 1]?.[2]}</p>
          </div>
          <span className="chip chip-active">Step {step} of {steps.length}</span>
        </div>
        {step === 1 && (
          <div className="stack">
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>👤</span>
                <div>
                  <h3>Employee & contract type</h3>
                  <p>Who is being employed and the legal shape of the arrangement.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Employee *</label>
                  <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                    <option value="">Select employee</option>
                    {employees.map((e) => (
                      <option key={String(e.id)} value={String(e.id)}>
                        {String(e.employeeNo ?? '')} - {employeeName(e)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Contract type *</label>
                  <div className="type-cards" role="radiogroup" aria-label="Contract type">
                    {CONTRACT_TYPES.map((t) => {
                      const info = CONTRACT_TYPE_INFO[t];
                      const active = contractType === t;
                      return (
                        <button key={t} type="button" role="radio" aria-checked={active} className={'type-card' + (active ? ' active' : '')} onClick={() => setContractType(t)}>
                          <span className="type-card-top">
                            <span className="type-card-name">{contractTypeLabel(t)}</span>
                            {!info.employment && <span className="chip">Non-employment</span>}
                            {active && <span className="type-card-check" aria-hidden>&#10003;</span>}
                          </span>
                          <span className="type-card-desc">{info.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className={'type-note callout ' + (CONTRACT_TYPE_INFO[contractType].employment === false ? 'callout-warn' : 'callout-info')}>
                    <span className="callout-icon" aria-hidden>{CONTRACT_TYPE_INFO[contractType].employment === false ? '\u26A0' : '\u2139'}</span>
                    <div className="callout-body">
                      <p className="callout-title">{CONTRACT_TYPE_INFO[contractType].employment === false ? 'Non-employment agreement' : 'Employment contract'}</p>
                      <p>{CONTRACT_TYPE_INFO[contractType].note}</p>
                    </div>
                  </div>
                </div>
                <div className="field"><label>Template</label>
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">Default for type</option>
                    {templates.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name ?? '')}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>📝</span>
                <div>
                  <h3>Reason & confirmation</h3>
                  <p>Optional context for the arrangement, plus the employment-classification confirmation where required.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Reason (fixed term, secondment, other)</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Project duration 12 months" /></div>
                {contractType === 'CONSULTANCY' && (
                  <div className="callout callout-warn" style={{ gridColumn: '1 / -1' }}>
                    <span className="callout-icon" aria-hidden>⚠</span>
                    <div className="callout-body">
                      <p className="callout-title">Not an employment relationship</p>
                      <p>Consultants, contractors and vendors are not employees under the Employment Act. Confirm the arrangement is genuine self-employment before continuing. Legal review is recommended where the classification is uncertain.</p>
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontWeight: 600, color: 'var(--ink)', fontSize: 12.5 }}>
                        <input type="checkbox" checked={employmentTypeConfirmed} onChange={(e) => setEmploymentTypeConfirmed(e.target.checked)} />
                        I confirm this is a genuine non-employment arrangement
                      </label>
                    </div>
                  </div>
                )}
                <div className="hint" style={{ gridColumn: '1 / -1' }}>Employee: {selectedEmployee ? employeeName(selectedEmployee) : 'not selected'}</div>
              </div>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="stack">
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🗓</span>
                <div>
                  <h3>Employment</h3>
                  <p>Dates, position and employee classification for this contract.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Start date *</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
                {contractType === 'FIXED_TERM' || contractType === 'TEMPORARY' || contractType === 'SECONDMENT' ? (
                  <div className="field"><label>End date *</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
                ) : (
                  <div className="field"><label>End date</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
                )}
                <div className="field"><label>Job title</label><input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Finance Officer" /></div>
                <div className="field"><label>Job code</label><input value={jobCode} onChange={(e) => setJobCode(e.target.value)} /></div>
                <div className="field"><label>Employee category</label><input value={employeeCategory} onChange={(e) => setEmployeeCategory(e.target.value)} placeholder="e.g. Professional" /></div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🏢</span>
                <div>
                  <h3>Organisation & supervision</h3>
                  <p>Department, location and reporting line for this role.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Department</label>
                  <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">-</option>{depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name ?? '')}</option>)}</select>
                </div>
                <div className="field"><label>Work location</label><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Kampala" /></div>
                <div className="field"><label>Reporting manager</label>
                  <select value={reportingManager} onChange={(e) => setReportingManager(e.target.value)}><option value="">-</option>{employees.map((e) => <option key={String(e.id)} value={String(e.id)}>{employeeName(e)}</option>)}</select>
                </div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>⏰</span>
                <div>
                  <h3>Working time & leave</h3>
                  <p>Hours, working and rest days, and leave entitlement. Statutory minimums are enforced by the compliance engine.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Working hours / week</label><input type="number" value={workingHoursPerWeek} onChange={(e) => setWorkingHoursPerWeek(e.target.value)} /></div>
                <div className="field"><label>Annual leave days</label><input type="number" value={annualLeaveDays} onChange={(e) => setAnnualLeaveDays(e.target.value)} /></div>
                <div className="field"><label>Expiry notification date</label><input type="date" value={expiryNotificationDate} onChange={(e) => setExpiryNotificationDate(e.target.value)} /></div>
                <div className="field"><label>Renewal eligible</label>
                  <select value={renewalEligibility ? 'yes' : 'no'} onChange={(e) => setRenewalEligibility(e.target.value === 'yes')}>
                    <option value="no">No</option><option value="yes">Yes</option>
                  </select>
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Working days</label>
                  <div className="chips">
                    {WEEK_DAYS.map((d) => (
                      <button key={d} type="button" className={workingDays.includes(d) ? 'chip chip-active' : 'chip'} onClick={() => toggle(workingDays, d, setWorkingDays)}>{d}</button>
                    ))}
                  </div>
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Rest days</label>
                  <div className="chips">
                    {WEEK_DAYS.map((d) => (
                      <button key={d} type="button" className={restDays.includes(d) ? 'chip chip-active' : 'chip'} onClick={() => toggle(restDays, d, setRestDays)}>{d}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>⚖</span>
                <div>
                  <h3>Notice & probation</h3>
                  <p>Termination notice arrangements{contractType === 'PROBATIONARY' ? ' and the probationary period.' : '.'}</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Notice period (days)</label><input type="number" value={noticePeriodDays} onChange={(e) => setNoticePeriodDays(e.target.value)} /></div>
                <div className="field"><label>Notice basis</label>
                  <select value={noticeBasis} onChange={(e) => setNoticeBasis(e.target.value)}>
                    <option value="STATUTORY">Statutory (Employment Act s.58)</option>
                    <option value="CONTRACTUAL">Contractual</option>
                    <option value="PAYMENT_IN_LIEU">Payment in lieu</option>
                  </select>
                </div>
                {contractType === 'PROBATIONARY' && (
                  <>
                    <div className="field"><label>Probation start</label><input type="date" value={probStart} onChange={(e) => setProbStart(e.target.value)} /></div>
                    <div className="field"><label>Probation end</label><input type="date" value={probEnd} onChange={(e) => setProbEnd(e.target.value)} /></div>
                    <div className="field"><label>Probation duration (days)</label><input type="number" value={probDuration} onChange={(e) => setProbDuration(e.target.value)} /></div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="stack">
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>💰</span>
                <div>
                  <h3>Payroll & statutory</h3>
                  <p>Core salary figures and payment terms. Statutory deductions are calculated by payroll, not here.</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Basic salary</label><input type="number" value={basic} onChange={(e) => setBasic(e.target.value)} /></div>
                <div className="field"><label>Gross salary</label><input type="number" value={gross} onChange={(e) => setGross(e.target.value)} /></div>
                <div className="field"><label>Currency</label>
                  <select value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                </div>
                <div className="field"><label>Pay frequency</label>
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>{SALARY_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                </div>
                <div className="hint" style={{ gridColumn: '1 / -1' }}>Statutory deductions (PAYE, NSSF) are not calculated here. The payroll engine supplies the authoritative calculation.</div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🧾</span>
                <div>
                  <h3>Allowances</h3>
                  <p>Cash allowances payable in addition to base salary.</p>
                </div>
              </div>
              <div className="stack">
                {allowances.map((a, i) => (
                  <div key={i} className="pay-row">
                    <div className="pay-row-head">
                      <span className="pay-row-title">Allowance {i + 1}</span>
                      <button type="button" className="btn btn-sm" onClick={() => setAllowances(allowances.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                    <div className="grid-2">
                      <select value={String(a.allowanceType ?? '')} onChange={(e) => patchAllowance(i, 'allowanceType', e.target.value)}>
                        {ALLOWANCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input value={String(a.name ?? '')} placeholder="Name" onChange={(e) => patchAllowance(i, 'name', e.target.value)} />
                      <input type="number" value={String(a.amount ?? '')} placeholder="Amount" onChange={(e) => patchAllowance(i, 'amount', e.target.value)} />
                      <input type="number" value={String(a.percentage ?? '')} placeholder="% of basic" onChange={(e) => patchAllowance(i, 'percentage', e.target.value)} />
                      <select value={String(a.frequency ?? 'MONTHLY')} onChange={(e) => patchAllowance(i, 'frequency', e.target.value)}>
                        {SALARY_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <label><input type="checkbox" checked={a.taxable !== false} onChange={(e) => patchAllowance(i, 'taxable', e.target.checked)} /> Taxable</label>
                    </div>
                  </div>
                ))}
                {allowances.length === 0 && <p className="muted">No allowances added yet.</p>}
                <div>
                  <button type="button" className="btn btn-sm" onClick={pushAllowance}>+ Add allowance</button>
                </div>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🎁</span>
                <div>
                  <h3>Benefits</h3>
                  <p>Employer-funded or non-cash benefits provided under this contract.</p>
                </div>
              </div>
              <div className="stack">
                {benefits.map((b, i) => (
                  <div key={i} className="pay-row">
                    <div className="pay-row-head">
                      <span className="pay-row-title">Benefit {i + 1}</span>
                      <button type="button" className="btn btn-sm" onClick={() => setBenefits(benefits.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                    <div className="grid-2">
                      <select value={String(b.benefitType ?? '')} onChange={(e) => patchBenefit(i, 'benefitType', e.target.value)}>
                        {BENEFIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input value={String(b.name ?? '')} placeholder="Name" onChange={(e) => patchBenefit(i, 'name', e.target.value)} />
                      <input type="number" value={String(b.employerCost ?? '')} placeholder="Employer cost" onChange={(e) => patchBenefit(i, 'employerCost', e.target.value)} />
                      <input type="number" value={String(b.employeeContribution ?? '')} placeholder="Employee contribution" onChange={(e) => patchBenefit(i, 'employeeContribution', e.target.value)} />
                      <select value={String(b.frequency ?? 'MONTHLY')} onChange={(e) => patchBenefit(i, 'frequency', e.target.value)}>
                        {SALARY_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <label><input type="checkbox" checked={b.taxable !== false} onChange={(e) => patchBenefit(i, 'taxable', e.target.checked)} /> Taxable</label>
                    </div>
                  </div>
                ))}
                {benefits.length === 0 && <p className="muted">No benefits added yet.</p>}
                <div>
                  <button type="button" className="btn btn-sm" onClick={pushBenefit}>+ Add benefit</button>
                </div>
              </div>
            </div>
          </div>
        )}
        {step === 4 && (
          <div className="stack">
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🧩</span>
                <div>
                  <h3>Clause triggers</h3>
                  <p>Conditions that select additional clauses automatically when the contract is generated.</p>
                </div>
              </div>
              <div className="def-sec-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                <label className="check-card"><input type="checkbox" checked={handlesPersonalData} onChange={(e) => setHandlesPersonalData(e.target.checked)} /> Handles personal data</label>
                <label className="check-card"><input type="checkbox" checked={hasConfidentialAccess} onChange={(e) => setHasConfidentialAccess(e.target.checked)} /> Confidential access</label>
                <label className="check-card"><input type="checkbox" checked={overtimeEligible} onChange={(e) => setOvertimeEligible(e.target.checked)} /> Overtime eligible</label>
              </div>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>📑</span>
                <div>
                  <h3>Additional clauses</h3>
                  <p>Template clauses are applied automatically. Extra clauses selected here are added to the generated contract.</p>
                </div>
              </div>
              <div className="chips">
                {clauses.map((c) => (
                  <button key={String(c.clauseCode)} type="button" className={clauseCodes.includes(String(c.clauseCode)) ? 'chip chip-active' : 'chip'} onClick={() => toggle(clauseCodes, String(c.clauseCode), setClauseCodes)}>
                    {String(c.name ?? c.clauseCode)}
                  </button>
                ))}
                {clauses.length === 0 && <p className="muted">No active clauses configured in the clause library.</p>}
              </div>
              {clauses.length > 0 && (
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const codes = clauses
                        .filter((c) => {
                          const types = parseJson<string[]>(c.applicableContractTypes, []);
                          return types.length === 0 || types.includes(contractType);
                        })
                        .map((c) => String(c.clauseCode));
                      setClauseCodes(codes);
                    }}
                  >
                    Attach all applicable clauses
                  </button>
                  {clauseCodes.length > 0 && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setClauseCodes([])}>Clear extra clauses</button>
                  )}
                </div>
              )}
              <p className="hint" style={{ marginTop: 10 }}>Attached clauses are stored on the contract and print in full with the written particulars. Contradictory clauses are rejected by the compliance engine before approval.</p>
            </div>
          </div>
        )}
        {step === 5 && (
          <div className="stack">
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>👤</span>
                <div><h3>Employee & role</h3><p>The individual, contract type and position.</p></div>
              </div>
              <dl className="def-list">
                <div><dt>Employee</dt><dd>{selectedEmployee ? employeeName(selectedEmployee) : '-'}</dd></div>
                <div><dt>Contract type</dt><dd>{contractTypeLabel(contractType)}</dd></div>
                <div><dt>Job title</dt><dd>{jobTitle || '-'}</dd></div>
                <div><dt>Department</dt><dd>{String(depts.find((d) => String(d.id) === departmentId)?.name ?? '-')}</dd></div>
              </dl>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>🗓</span>
                <div><h3>Employment terms</h3><p>Dates, working hours and leave entitlement.</p></div>
              </div>
              <dl className="def-list">
                <div><dt>Start date</dt><dd>{fmtDate(startDate)}</dd></div>
                <div><dt>End date</dt><dd>{fmtDate(endDate)}</dd></div>
                <div><dt>Working hours</dt><dd>{workingHoursPerWeek ? workingHoursPerWeek + ' hrs/week' : '-'}</dd></div>
                <div><dt>Annual leave</dt><dd>{annualLeaveDays ? annualLeaveDays + ' days' : '-'}</dd></div>
              </dl>
            </div>
            <div className="def-sec">
              <div className="def-sec-head">
                <span className="def-sec-icon" aria-hidden>💰</span>
                <div><h3>Compensation & clauses</h3><p>Salary, allowances, benefits and clause selection.</p></div>
              </div>
              <dl className="def-list">
                <div><dt>Basic salary</dt><dd>{basic ? fmtMoney(basic) + ' ' + currency : '-'}</dd></div>
                <div><dt>Gross salary</dt><dd>{gross ? fmtMoney(gross) + ' ' + currency : '-'}</dd></div>
                <div><dt>Allowances</dt><dd>{allowances.length ? allowances.length + ' configured' : '-'}</dd></div>
                <div><dt>Benefits</dt><dd>{benefits.length ? benefits.length + ' configured' : '-'}</dd></div>
                <div><dt>Extra clauses</dt><dd>{clauseCodes.length ? clauseCodes.length + ' selected' : 'Template default'}</dd></div>
              </dl>
            </div>
            <div className="callout callout-warn">
              <span className="callout-icon" aria-hidden>⚠</span>
              <div className="callout-body">
                <p className="callout-title">Draft only — not legally effective</p>
                <p>This draft must pass compliance validation, the configured approval workflow and both signatures before it is executed. Statutory rights are never reduced.</p>
              </div>
            </div>
          </div>
        )}
        <div className="composer-foot">
          {step < steps.length && !canNext() && nextHint() && (
            <p className="composer-hint" role="status">{nextHint()}</p>
          )}
          <span className="kbd-hints" aria-hidden>
            <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> navigate{step === steps.length ? <> · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> create</> : null}
          </span>
          {step > 1 && <button className="btn" disabled={busy} onClick={() => setStep(step - 1)}>← Back</button>}
          {step < steps.length ? (
            <button className="btn btn-primary" disabled={busy || !canNext()} onClick={() => setStep(step + 1)}>Continue →</button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !employeeId} onClick={create}>{busy ? 'Creating draft…' : 'Create draft contract'}</button>
          )}
        </div>
      </section>
    </div>
  );
}


const CONTRACT_STATUSES = ['DRAFT','VALIDATING','SUBMITTED','HR_REVIEW','MANAGER_REVIEW','FINANCE_REVIEW','LEGAL_REVIEW','APPROVED','SENT_FOR_SIGNATURE','PARTIALLY_SIGNED','EXECUTED','ACTIVE','VARIED','RENEWED','EXPIRED','TERMINATED','ARCHIVED','REJECTED'];

// ============================================================
// CONTRACT REGISTER (list)
// ============================================================

function ContractList() {
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [contractType, setContractType] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const load = useCallback(() => {
    setError('');
    setLoading(true);
    const p: string[] = [];
    if (q.trim()) p.push('q=' + encodeURIComponent(q.trim()));
    if (status) p.push('status=' + encodeURIComponent(status));
    if (contractType) p.push('contractType=' + encodeURIComponent(contractType));
    p.push('page=' + page, 'pageSize=40');
    api<{ data: { items: Rec[]; total: number } }>('/api/ops/hr/contracts?' + p.join('&'))
      .then((r) => { setItems(r.data.items ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Contract list failed'))
      .finally(() => setLoading(false));
  }, [q, status, contractType, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [items]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === '/') {
        e.preventDefault();
        if (searchRef.current) searchRef.current.focus();
      } else if (e.key.toLowerCase() === 'n' && can(user, 'hr.contracts.create')) {
        e.preventDefault();
        navigate('/people/contracts/new');
      } else if (e.key === 'Escape') {
        if (selected.size > 0) setSelected(new Set());
        else if (q.trim()) resetPage(setQ, '');
        else if (status) resetPage(setStatus, '');
        else if (contractType) resetPage(setContractType, '');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user, q, status, contractType, selected.size]);
  const resetPage = (setter: (v: string) => void, v: string) => { setter(v); setPage(1); };
  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = items.map((c) => Number(c.id));
      const all = ids.length > 0 && ids.every((id) => next.has(id));
      if (all) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };
  const exportCsv = (only: boolean) => {
    const rows: string[][] = [
      ['Contract No', 'Type', 'Status', 'Version', 'Employee No', 'Employee', 'Job Title', 'Department', 'Branch', 'Start Date', 'End Date', 'Basic Salary', 'Gross Salary', 'Currency'],
    ];
    (only ? items.filter((c) => selected.has(Number(c.id))) : items).forEach((c) => {
      rows.push([
        String(c.contractNo ?? ''), contractTypeLabel(String(c.contractType ?? '')), String(c.status ?? '').replace(/_/g, ' '),
        String(c.version ?? ''), String(c.employeeNo ?? ''), String(c.firstName ?? '') + ' ' + String(c.lastName ?? ''),
        String(c.jobTitle ?? ''), String(c.departmentName ?? ''), String(c.branchName ?? ''),
        String(c.startDate ?? ''), String(c.endDate ?? ''), String(c.salary ?? ''), String(c.grossSalary ?? ''), String(c.currency ?? ''),
      ]);
    });
    downloadCsv(only ? 'contract-register-selected.csv' : 'contract-register.csv', rows);
  };
  const allSelected = items.length > 0 && items.every((c) => selected.has(Number(c.id)));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Contract register</h1>
          <p className="muted">Search and manage all employment contracts across the organisation.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => exportCsv(false)} title="Export register as CSV">&#11015; Export</button>
          <button className="btn btn-primary" onClick={() => navigate('/people/contracts/new')}>+ New contract</button>
        </div>
      </header>
      <ModuleTabs active="list" />
      <section>
        <div className="toolbar">
          <input ref={searchRef} className="search-input" placeholder="Search employee, contract no, job title" value={q} onChange={(e) => resetPage(setQ, e.target.value)} />
          <select value={status} onChange={(e) => resetPage(setStatus, e.target.value)}>
            <option value="">All statuses</option>
            {CONTRACT_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <select value={contractType} onChange={(e) => resetPage(setContractType, e.target.value)}>
            <option value="">All types</option>
            {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{contractTypeLabel(t)}</option>)}
          </select>
          <span className="kbd-hints" aria-hidden><kbd>/</kbd> search &#183; <kbd>n</kbd> new &#183; <kbd>esc</kbd> clear</span>
        </div>
        <div className="list-meta">
          <span className="muted">{fmtNum(total)} contract(s)</span>
          {(status || contractType || q.trim()) && (
            <div className="chips">
              {q.trim() && <button className="chip" onClick={() => resetPage(setQ, '')}>Search &ldquo;{q.trim()}&rdquo; <span className="chip-x" aria-hidden>{'\u2715'}</span></button>}
              {status && <button className="chip" onClick={() => resetPage(setStatus, '')}>Status: {status.replace(/_/g, ' ')} <span className="chip-x" aria-hidden>{'\u2715'}</span></button>}
              {contractType && <button className="chip" onClick={() => resetPage(setContractType, '')}>Type: {contractTypeLabel(contractType)} <span className="chip-x" aria-hidden>{'\u2715'}</span></button>}
            </div>
          )}
        </div>
        {selected.size > 0 && (
          <div className="bulk-bar">
            <span className="bulk-count"><b>{selected.size}</b> selected</span>
            <button className="btn btn-sm" onClick={() => exportCsv(true)}>Export selected</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        {error && <ErrorBanner error={error} />}
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th className="col-check"><input type="checkbox" className="checkbox-cell" checked={allSelected} onChange={toggleAll} aria-label="Select all rows" /></th>
                <th>Contract</th><th>Employee</th><th>Type</th><th>Status</th><th>Department</th><th>Branch</th><th>Start</th><th>End</th><th>Gross</th>
                <th className="col-actions" aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const id = Number(c.id);
                const end = c.endDate ? daysUntil(c.endDate) : null;
                const endPill = c.endDate && end !== null && end >= 0
                  ? end <= 30 ? <span className="pill pill-danger">{end} days</span>
                  : end <= 90 ? <span className="pill pill-warn">{end} days</span>
                  : <span className="pill pill-ok">{end} days</span>
                  : null;
                return (
                  <tr key={String(c.id)} className={'row-click' + (selected.has(id) ? ' row-selected' : '')} onClick={() => navigate('/people/contracts/' + String(c.id))}>
                    <td className="checkbox-cell" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(id)} onChange={() => toggleRow(id)} aria-label={'Select ' + String(c.contractNo ?? 'contract')} />
                    </td>
                    <td className="td-cell-mono">{String(c.contractNo ?? '-')}<span className="reg-version">{' v' + String(c.version ?? '1.0')}</span></td>
                    <td><Avatar name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')} sub={String(c.employeeNo ?? '') + (c.jobTitle ? '\u00B7 ' + String(c.jobTitle) : '')} size="sm" /></td>
                    <td>{typeChip(String(c.contractType ?? ''))}</td>
                    <td><Badge value={c.status} /></td>
                    <td>{String(c.departmentName ?? '-')}</td>
                    <td>{String(c.branchName ?? '-')}</td>
                    <td>{fmtD(c.startDate)}</td>
                    <td><span className="expiry-cell">{fmtD(c.endDate)}{endPill}</span></td>
                    <td className="td-strong">{fmtUGX(c.grossSalary ?? c.salary, c.currency)}{c.salaryFrequency ? <span className="reg-version" style={{ display: 'inline-block', marginLeft: 6 }}>{' \u00B7 ' + String(c.salaryFrequency).toLowerCase()}</span> : null}</td>
                    <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                      <span className="action-group">
                        <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(c.id))}>Open</button>
                        <button
                          className="btn btn-sm"
                          title="Print with all clauses"
                          onClick={async () => {
                            try {
                              await openDocument('employment-contract', c.id, 'print', String(c.contractNo ?? 'contract') + '.pdf');
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err));
                            }
                          }}
                        >Print</button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {loading && items.length === 0 ? <LoadingRow label={'Loading contracts\u2026'} colSpan={11} /> : items.length === 0 ? <tr><td colSpan={11}><EmptyState icon={'\uD83D\uDCC4'} title="No contracts found" hint="Try adjusting your search or filters, or create a new contract."><button className="btn btn-primary btn-sm" onClick={() => navigate('/people/contracts/new')}>New contract</button></EmptyState></td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page} pageSize={40} total={total} onPage={setPage} />
      </section>
    </div>
  );
}


// ============================================================
// CONTRACT DESK (detail, lifecycle, tabs)
// ============================================================

const VAR_FIELD_OPTIONS: Array<[string, string]> = [
  ['basic', 'Basic salary'],
  ['gross', 'Gross salary'],
  ['jobTitle', 'Job title'],
  ['jobCode', 'Job code'],
  ['departmentId', 'Department'],
  ['branchId', 'Branch'],
  ['location', 'Workplace'],
  ['workingHoursPerWeek', 'Working hours / week'],
  ['annualLeaveDays', 'Annual leave days'],
  ['noticePeriodDays', 'Notice period days'],
  ['noticeBasis', 'Notice basis'],
  ['currency', 'Currency'],
  ['frequency', 'Salary frequency'],
];

function varFieldLabel(f: string): string {
  const hit = VAR_FIELD_OPTIONS.find(([k]) => k === f);
  return hit ? hit[1] : f;
}

function ContractDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState('');
  const [validateResult, setValidateResult] = useState<Rec | null>(null);
  const [executed, setExecuted] = useState<{ secret: string; verificationCode: string } | null>(null);
  const [modal, setModal] = useState('');
  const [signerType, setSignerType] = useState('EMPLOYEE');
  const [signature, setSignature] = useState('');
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [witnessName, setWitnessName] = useState('');
  const [witnessEmail, setWitnessEmail] = useState('');
  const [variationType, setVariationType] = useState('SALARY');
  const [varReason, setVarReason] = useState('');
  const [varEffectiveDate, setVarEffectiveDate] = useState('');
  const [varChanges, setVarChanges] = useState<Array<{ field: string; oldValue: string; newValue: string }>>([
    { field: 'basic', oldValue: '', newValue: '' },
  ]);
  const [renStart, setRenStart] = useState('');
  const [renEnd, setRenEnd] = useState('');
  const [renReason, setRenReason] = useState('');
  const [photoRev, setPhotoRev] = useState(0);
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/hr/contracts/' + String(id))
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Contract load failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!data || isTypingTarget(e) || modal) return;
      const k = e.key.toLowerCase();
      if (k === 'v' && canValidate) { e.preventDefault(); doValidate(); }
      else if (k === 's' && canSubmit) { e.preventDefault(); doSubmit(); }
      else if (k === 'd' && canView) { e.preventDefault(); downloadPdf(); }
      else if (k === 'p' && canView) { e.preventDefault(); printContract(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening contract" />;
  const c = (data.contract ?? {}) as Rec;
  const terms = (data.terms ?? []) as Rec[];
  const allowances = (data.allowances ?? []) as Rec[];
  const benefits = (data.benefits ?? []) as Rec[];
  const signatures = (data.signatures ?? []) as Rec[];
  const approvals = (data.approvals ?? []) as Rec[];
  const compliance = (data.compliance ?? []) as Rec[];
  const variations = (data.variations ?? []) as Rec[];
  const renewals = (data.renewals ?? []) as Rec[];
  const documents = (data.documents ?? []) as Rec[];
  const audit = (data.audit ?? []) as Rec[];
  const statusNow = String(c.status ?? '');
  const canView = can(user, 'hr.contracts.view');
  const canValidate = can(user, 'hr.contracts.validate');
  const canSubmit = can(user, 'hr.contracts.submit') && (statusNow === 'DRAFT' || statusNow === 'VALIDATING');
  const canSign = can(user, 'hr.contracts.sign') && (statusNow === 'SENT_FOR_SIGNATURE' || statusNow === 'PARTIALLY_SIGNED');
  const canVary = can(user, 'hr.contracts.vary') && (statusNow === 'EXECUTED' || statusNow === 'ACTIVE');
  const canRenew = can(user, 'hr.contracts.renew') && (statusNow === 'EXECUTED' || statusNow === 'ACTIVE');
  const lastCompliance = compliance.length ? (compliance[0] as Rec) : null;

  const act = (path: string, body: unknown, done?: (r: Rec) => void) => {
    setBusy(path); setError(''); setNotice('');
    api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then((r) => {
        if (done) done(r.data);
        setBusy('');
        load();
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(''); });
  };
  const filename = String(c.contractNo ?? ('contract-' + String(id))) + '.pdf';
  const downloadPdf = async () => {
    setError('');
    try {
      await openDocument('employment-contract', id, 'pdf', filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const printContract = async () => {
    setError('');
    try {
      await openDocument('employment-contract', id, 'print', filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copyExecuted = () => {
    if (!executed) return;
    try { navigator.clipboard.writeText(executed.secret + ' | ' + executed.verificationCode); setNotice('Verification details copied.'); }
    catch { setNotice('Copy manually: secret + verification code shown below.'); }
  };
  const doValidate = () => {
    setValidateResult(null);
    act('/api/ops/hr/contracts/' + String(id) + '/validate', {}, (r) => setValidateResult(r));
  };
  const doSubmit = () => {
    setValidateResult(null);
    act('/api/ops/hr/contracts/' + String(id) + '/submit', {}, (r) => {
      setNotice('Submitted. Status: ' + String(r.status) + (r.readyForSignature ? ' - ready for signature.' : ''));
    });
  };
  const doRequestSignature = () => {
    setModal('');
    act('/api/ops/hr/contracts/' + String(id) + '/request-signature', { signerType }, () => {
      setNotice('Signature request sent to pending signatories.');
    });
  };
  const doSign = async () => {
    setModal('');
    const body: Rec = { signerType };
    if (signature.trim()) body.signature = signature.trim();
    if (signatureFile) {
      const fd = new FormData();
      fd.append('file', signatureFile);
      fd.append('signerType', signerType);
      try {
        const up = await api<{ data: { url: string } }>('/api/ops/hr/contracts/' + String(id) + '/signature-image', { method: 'POST', body: fd });
        body.signatureUrl = up.data.url;
      } catch (e) {
        setModal('sign');
        setError(e instanceof Error ? e.message : 'Signature image upload failed');
        return;
      }
    }
    if (signerType === 'WITNESS') {
      body.witnessName = witnessName.trim();
      body.witnessEmail = witnessEmail.trim() || undefined;
    }
    setSignatureFile(null);
    act('/api/ops/hr/contracts/' + String(id) + '/sign', body, (r) => {
      if (r.executed) {
        setExecuted({ secret: String(r.secret ?? ''), verificationCode: String(r.verificationCode ?? '') });
        setNotice('Contract fully signed and executed. Keep the verification details safe.');
      } else {
        setNotice('Signature recorded. Status: ' + String(r.status));
      }
    });
  };
  const doVariation = () => {
    setModal('');
    const changes = varChanges
      .filter((x) => x.field)
      .map((x) => ({ field: x.field, label: varFieldLabel(x.field), oldValue: x.oldValue, newValue: x.newValue }));
    const newValues: Rec = {};
    varChanges.forEach((x) => { if (x.field && x.newValue !== '') newValues[x.field] = x.newValue; });
    act('/api/ops/hr/contracts/' + String(id) + '/variations', {
      variationType,
      reason: varReason,
      changes,
      newValues,
      oldValues: {},
      effectiveDate: varEffectiveDate || undefined,
    }, (r) => {
      setNotice('Variation ' + String(r.variationNo ?? '') + ' created - applying.');
      act('/api/ops/hr/contracts/variations/' + String(r.id) + '/apply', {}, () => {
        setNotice('Variation applied. The source contract is frozen and a new VARIATION version was created.');
      });
    });
  };
  const doRenewal = () => {
    setModal('');
    act('/api/ops/hr/contracts/' + String(id) + '/renewals', {
      newStartDate: renStart,
      newEndDate: renEnd || undefined,
      reason: renReason,
    }, (r) => {
      setNotice('Renewal ' + String(r.renewalNo ?? '') + ' created - applying.');
      act('/api/ops/hr/contracts/renewals/' + String(r.id) + '/apply', {}, () => {
        setNotice('Renewal applied. The source contract is frozen and a new RENEWAL contract was created.');
      });
    });
  };
  const patchVar = (i: number, key: string, v: string) => {
    setVarChanges(varChanges.map((x, j) => (j === i ? { ...x, [key]: v } : x)));
  };
  const issue = (lastCompliance ? parseJson<Rec[]>(lastCompliance.issues, []) : []) as Rec[];
  const terminal = lifecycleTerminal(statusNow);
  const hasPhoto = Boolean(c.hasPhoto || c.photoPath);
  const attachPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy('photo'); setError(''); setNotice('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'PASSPORT');
      await api('/api/ops/hr/contracts/' + String(id) + '/employee-photo', { method: 'POST', body: fd });
      setNotice('Passport photograph attached. Print the contract to include it next to the employee particulars.');
      setPhotoRev((n) => n + 1);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div className="photo-attach">
            <StaffPhoto
              path={'/api/ops/hr/contracts/' + String(id) + '/employee-photo?r=' + photoRev}
              hasPhoto={hasPhoto}
              name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')}
              size={78}
            />
            {can(user, 'hr.contracts.update') && (
              <label className="btn btn-sm">
                {hasPhoto ? 'Change photo' : 'Attach photo'}
                <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden disabled={busy !== ''} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; void attachPhoto(f); }} />
              </label>
            )}
          </div>
          <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>
            <span className="cell-mono">{String(c.contractNo ?? '-')}</span>
            {' '}<Badge value={c.status} />
            {' '}<span className="muted">v{String(c.version ?? 1)}</span>
          </h1>
          <p className="muted">
            {String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')}
            {' \u00B7 '}{typeChip(String(c.contractType ?? ''))}
            {' · '}{String(c.jobTitle ?? '')}
            {c.departmentName ? ' · ' + String(c.departmentName) : ''}
          </p>
          <div className="page-meta">
            <span>Created <b>{fmtDate(c.createdAt)}</b></span>
            <span>Start <b>{fmtDate(c.startDate)}</b></span>
            <span>End <b>{fmtDate(c.endDate)}</b></span>
            <span>Legal framework <b>{String(c.legalFrameworkVersion ?? '-')}</b></span>
          </div>
          </div>
        </div>
        <div className="head-actions">
          {canValidate && <button className="btn" disabled={busy !== ''} onClick={doValidate}>Validate</button>}
          {canSubmit && <button className="btn btn-primary" disabled={busy !== ''} onClick={doSubmit}>Submit for approval</button>}
          {canSign && <button className="btn" disabled={busy !== ''} onClick={() => { setModal('request-sign'); setSignerType('ALL'); }}>Request signature</button>}
          {canSign && <button className="btn btn-success" disabled={busy !== ''} onClick={() => { setModal('sign'); setSignerType('EMPLOYEE'); }}>Sign</button>}
          {canVary && <button className="btn" disabled={busy !== ''} onClick={() => { setModal('variation'); setVarChanges([{ field: 'basic', oldValue: String(c.salary ?? ''), newValue: '' }]); }}>New variation</button>}
          {canRenew && <button className="btn" disabled={busy !== ''} onClick={() => { setModal('renewal'); setRenStart(String(c.endDate ?? '').slice(0, 10)); }}>New renewal</button>}
          {canView && (
            <span className="action-group">
              <button className="btn" disabled={busy !== ''} onClick={printContract}>Print</button>
              <button className="btn" disabled={busy !== ''} onClick={downloadPdf}>Download PDF</button>
            </span>
          )}
          {can(user, 'hr.certificates.create') && (
            <button className="btn" onClick={() => navigate('/people/contracts/certificates?contract=' + String(id))}>Certificate</button>
          )}
          <span className="kbd-hints" aria-hidden>
            {canValidate ? <><kbd>v</kbd> validate</> : null}
            {canSubmit ? <><kbd>s</kbd> submit</> : null}
            {canView ? <><kbd>p</kbd> print</> : null}
            {canView ? <><kbd>d</kbd> download</> : null}
          </span>
        </div>
      </header>
      {terminal ? (
        <div className={'lc-note ' + terminal.kind}>
          <span className="lc-note-dot" aria-hidden />
          {terminal.label}
        </div>
      ) : (
        <ol className="lifecycle" aria-label="Contract lifecycle">
          {LIFECYCLE.map(([label], i) => {
            const idx = lifecycleIndex(statusNow);
            const done = i < idx;
            const current = i === idx;
            return (
              <li key={label} className={'lc-step' + (done ? ' done' : '') + (current ? ' current' : '')}>
                <span className="lc-dot" aria-hidden>{done ? '✓' : String(i + 1)}</span>
                <span className="lc-label">{label}</span>
              </li>
            );
          })}
        </ol>
      )}
      <ModuleTabs active="board" />
      {error && <ErrorBanner error={error} />}
      {notice && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>✓</span>
          <div className="callout-body">
            <p style={{ color: 'var(--ink)' }}>{notice}</p>
          </div>
        </div>
      )}
      {executed && (
        <div className="callout callout-warn">
          <span className="callout-icon" aria-hidden>🔑</span>
          <div className="callout-body">
            <p className="callout-title">Verification details (one-time)</p>
            <p>Secret: <code className="code-chip">{executed.secret}</code></p>
            <p>Verification code: <code className="code-chip">{executed.verificationCode}</code></p>
            <p>Verification method: <code className="code-chip">POST /api/public/verify-contract</code></p>
            <div className="callout-actions">
              <button className="btn btn-sm" onClick={copyExecuted}>Copy</button>
            </div>
          </div>
        </div>
      )}
      {validateResult && (
        <div className={'callout ' + (String(validateResult.result) === 'GREEN' ? 'callout-success' : String(validateResult.result) === 'AMBER' ? 'callout-warn' : 'callout-error')}>
          <span className="callout-icon" aria-hidden>⚖</span>
          <div className="callout-body">
            <p className="callout-title">Compliance: {String(validateResult.result)}</p>
            <p>passed {fmtNum((validateResult.summary as Rec)?.passed)} · warnings {fmtNum((validateResult.summary as Rec)?.warnings)} · failed {fmtNum((validateResult.summary as Rec)?.failed)}</p>
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {((validateResult.issues as Rec[]) ?? []).map((i2, idx) => (
                <li key={idx}>
                  <strong>{String(i2.check)}</strong> ({String(i2.status)}) - {String(i2.reason)}
                  {i2.legalRef ? <div className="muted">{String(i2.legalRef)}{i2.ruleCode ? ' [' + String(i2.ruleCode) + ']' : ''}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="tabs" style={{ marginTop: 12 }}>
        {[['overview', 'Overview'], ['terms', 'Terms & clauses'], ['compensation', 'Compensation'], ['signatures', 'Signatures'], ['approvals', 'Approvals'], ['compliance', 'Compliance'], ['variations', 'Variations'], ['audit', 'Audit']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <section className="card card-pad" style={{ marginTop: 12 }}>
        {tab === 'overview' && (
          <div className="def-sec-grid">
            <DefSec icon="👤" title="Employee" sub={String(c.employeeNo ?? '-')}>
              <DefRow k="Full name" v={<Avatar name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')} size="sm" />} />
              <DefRow k="Employee no" v={String(c.employeeNo ?? '-')} mono />
              <DefRow k="Photograph" v={hasPhoto ? 'Attached — prints on the contract' : 'Not attached'} />
              <DefRow k="Email" v={String(c.employeeEmail ?? '')} />
              <DefRow k="Phone" v={String(c.employeePhone ?? '')} />
              <DefRow k="Address" v={String(c.employeeAddress ?? '')} />
              <DefRow k="Hire date" v={fmtDate(c.hireDate)} />
            </DefSec>
            <DefSec icon="💼" title="Employment" sub={contractTypeLabel(String(c.contractType ?? ''))}>
              <DefRow k="Job title" v={String(c.jobTitle ?? '-')} />
              <DefRow k="Job code" v={String(c.jobCode ?? '-')} mono />
              <DefRow k="Department" v={String(c.departmentName ?? '-')} />
              <DefRow k="Branch" v={String(c.branchName ?? '-')} />
              <DefRow k="Manager" v={String(c.reportingManagerName ?? '-')} />
              <DefRow k="Start date" v={fmtDate(c.startDate)} />
              <DefRow k="End date" v={fmtDate(c.endDate)} />
              <DefRow k="Location" v={String(c.location ?? '-')} />
              {c.previousContractId ? <DefRow k="Derived from" v={'contract #' + String(c.previousContractId)} mono /> : null}
            </DefSec>
            <DefSec icon="💰" title="Compensation" sub={String(c.currency ?? 'UGX')}>
              <DefRow k="Basic salary" v={fmtMoney(c.salary)} />
              <DefRow k="Gross salary" v={fmtMoney(c.grossSalary)} />
              <DefRow k="Frequency" v={String(c.salaryFrequency ?? 'MONTHLY')} />
              <DefRow k="Hours / week" v={String(c.workingHoursPerWeek ?? '-')} />
              <DefRow k="Annual leave" v={String(c.annualLeaveDays ?? '-') + ' days'} />
              <DefRow k="Notice" v={String(c.noticePeriodDays ?? '-') + ' days (' + String(c.noticeBasis ?? '-') + ')'} />
            </DefSec>
            <DefSec icon="🏢" title="Employer" sub={String(c.companyLegalName ?? c.companyName ?? '-')}>
              <DefRow k="Address" v={String(c.companyAddress ?? '')} />
              <DefRow k="Contact" v={String(c.companyPhone ?? '') + (c.companyEmail ? ' · ' + String(c.companyEmail) : '')} />
              <DefRow k="TIN" v={String(c.tin ?? '-')} mono />
              <DefRow k="Representative" v={String(c.employerRepName ?? '-')} />
              <DefRow k="Title" v={String(c.employerRepTitle ?? '-')} />
            </DefSec>
            <DefSec icon="⏳" title="Probation" sub={String(c.probationDurationDays ?? '-') + ' days'}>
              <DefRow k="Start" v={fmtDate(c.probationStartDate)} />
              <DefRow k="End" v={fmtDate(c.probationEndDate)} />
              <DefRow k="Duration" v={String(c.probationDurationDays ?? '-') + ' days'} />
              <DefRow k="Category" v={String(c.employeeCategory ?? '-')} />
            </DefSec>
            <DefSec icon="📄" title="Document" sub={'v' + String(c.version ?? 1)}>
              <DefRow k="Legal framework" v={String(c.legalFrameworkVersion ?? '-')} />
              <DefRow k="Renewal eligible" v={c.renewalEligibility ? 'Yes' : 'No'} />
              <DefRow k="Reason" v={String(c.reason ?? '-')} />
              <DefRow k="Created" v={fmtDate(c.createdAt)} />
              {c.signedByEmployeeAt ? <DefRow k="Employee signed" v={fmtDate(c.signedByEmployeeAt)} /> : null}
              {c.signedByEmployerAt ? <DefRow k="Employer signed" v={fmtDate(c.signedByEmployerAt)} /> : null}
            </DefSec>
          </div>
        )}
        {tab === 'terms' && (
          <div className="stack">
            <div className="callout">
              <span className="callout-icon" aria-hidden>📋</span>
              <div className="callout-body">
                <p className="callout-title">Statutory written particulars</p>
                <p>Written particulars are generated from the recorded fields; clauses shown here were selected from the clause library at generation time. Clause text is versioned and never rewritten after execution.</p>
              </div>
            </div>
            {terms.length === 0 ? (
              <EmptyState icon="📄" title="No terms recorded" hint="Clauses selected from the clause library at generation time appear here with their versioned text." />
            ) : (
              terms.map((t) => (
                <section key={String(t.id)} className="card def-sec">
                  <div className="def-sec-head">
                    <span className="def-sec-icon" aria-hidden>⚖️</span>
                    <div>
                      <h3>{String(t.title ?? '')}</h3>
                      <p>{String(t.termType ?? 'CLAUSE') === 'PARTICULAR' ? 'Written particular' : t.legalReference ? String(t.legalReference) : String(t.termType ?? 'CLAUSE').toLowerCase().replace(/_/g, ' ')}</p>
                    </div>
                    {t.clauseVersion ? <span style={{ marginLeft: 'auto' }}><Badge value={'v' + String(t.clauseVersion)} /></span> : null}
                  </div>
                  <p className="muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{termBody(t)}</p>
                </section>
              ))
            )}
          </div>
        )}
        {tab === 'compensation' && (
          <div className="def-sec-grid">
            <DefSec icon="💰" title="Salary" sub={String(c.currency ?? 'UGX')}>
              <DefRow k="Basic salary" v={fmtMoney(c.salary)} />
              <DefRow k="Gross salary" v={fmtMoney(c.grossSalary)} />
              <DefRow k="Frequency" v={String(c.salaryFrequency ?? 'MONTHLY')} />
              <DefRow k="Hours / week" v={String(c.workingHoursPerWeek ?? '-')} />
              <DefRow k="Annual leave" v={String(c.annualLeaveDays ?? '-') + ' days'} />
            </DefSec>
            <DefSec icon="🧾" title={'Allowances (' + allowances.length + ')'} sub="Per-component taxable flag">
              {allowances.length === 0 ? (
                <DefRow k="Allowances" v="None configured." />
              ) : (
                allowances.map((a) => (
                  <DefRow
                    key={String(a.id)}
                    k={String(a.allowanceType ?? 'ALLOWANCE').toLowerCase().replace(/_/g, ' ')}
                    v={
                      <span>
                        {fmtMoney(a.amount)}
                        <span className="muted"> · {String(a.frequency ?? 'MONTHLY').toLowerCase()}</span>
                        {a.taxable === false ? <span className="td-cell-mono" style={{ display: 'block', fontWeight: 400 }}>non-taxable</span> : null}
                      </span>
                    }
                  />
                ))
              )}
            </DefSec>
            <DefSec icon="🛡️" title={'Benefits (' + benefits.length + ')'} sub="Non-cash and cash benefits">
              {benefits.length === 0 ? (
                <DefRow k="Benefits" v="None configured." />
              ) : (
                benefits.map((b) => (
                  <DefRow
                    key={String(b.id)}
                    k={String(b.benefitType ?? 'BENEFIT').toLowerCase().replace(/_/g, ' ')}
                    v={
                      <span>
                        {fmtMoney(b.amount)}
                        <span className="muted"> · {String(b.frequency ?? 'MONTHLY').toLowerCase()}</span>
                        {b.taxable === false ? <span className="td-cell-mono" style={{ display: 'block', fontWeight: 400 }}>non-taxable</span> : null}
                      </span>
                    }
                  />
                ))
              )}
            </DefSec>
          </div>
        )}
        {tab === 'signatures' && (
          signatures.length === 0 ? (
            <EmptyState icon="✍️" title="No signatures yet" hint="Once approved, the contract is sent for signature. Signature events are recorded here with timestamps, IP and device information." />
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Signer</th><th>Name</th><th>Status</th><th>Signed at</th><th>IP / device</th></tr>
                  </thead>
                  <tbody>
                    {signatures.map((s) => (
                      <tr key={String(s.id)}>
                        <td><span className="td-strong">{String(s.signerType ?? '')}</span></td>
                        <td>{s.signerName ? <Avatar name={String(s.signerName)} size="sm" /> : <span className="muted">—</span>}</td>
                        <td><Badge value={s.status} /></td>
                        <td className="td-cell-mono">{fmtDate(s.signedAt)}</td>
                        <td className="muted">{String(s.ip ?? '')}{s.device ? ' / ' + String(s.device) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}
        {tab === 'approvals' && (
          approvals.length === 0 ? (
            <EmptyState icon="🗂️" title="No approval steps" hint="Approval steps follow the organisation workflow configuration. Decisions, approvers and comments appear here." />
          ) : (
            <div className="contract-approvals">
              <div className="contract-approval-grid head">
                <span>Step</span><span>Name</span><span>Role</span><span>Approver</span><span>Status</span><span>Decided</span><span>Comments</span>
              </div>
              {approvals.map((a) => (
                <div className="contract-approval-grid" key={String(a.id)}>
                  <span className="td-cell-mono">{String(a.stepSeq ?? '')}</span>
                  <span className="td-strong">{String(a.stepName ?? '-')}</span>
                  <span className="muted">{String(a.approverRole ?? '-')}</span>
                  <span>{String((a.approverFirstName ?? '') + ' ' + (a.approverLastName ?? '')).trim() || '—'}</span>
                  <span><Badge value={a.status} /></span>
                  <span className="td-cell-mono">{fmtDate(a.decidedAt)}</span>
                  <span className="muted" style={{ minWidth: 0, wordBreak: 'break-word' }}>{String(a.comments ?? '—')}</span>
                </div>
              ))}
            </div>
          )
        )}
        {tab === 'compliance' && (
          <div className="stack">
            {lastCompliance ? (
              <div className="card def-sec">
                <div className="def-sec-head">
                  <span className="def-sec-icon" aria-hidden>🛡️</span>
                  <div>
                    <h3>Latest compliance check</h3>
                    <p>Run {fmtDate(lastCompliance.checkedAt)}</p>
                  </div>
                  <span style={{ marginLeft: 'auto' }}><Badge value={lastCompliance.result} /></span>
                </div>
                <dl className="def-list">
                  <DefRow k="Result" v={<span className="td-strong">{String(lastCompliance.result)}</span>} />
                  <DefRow k="Issues" v={String(issue.length)} />
                  <DefRow k="Legal framework" v={String(c.legalFrameworkVersion ?? '-')} mono />
                </dl>
                {issue.length > 0 && (
                  <div className="stack" style={{ marginTop: 14 }}>
                    {issue.map((i2, idx) => {
                      const st = String(i2.status ?? '');
                      const cls = st === 'FAIL' ? 'callout-error' : st === 'WARN' ? 'callout-warn' : 'callout-success';
                      const icon = st === 'FAIL' ? '⛔' : st === 'WARN' ? '⚠️' : '✅';
                      return (
                        <div key={idx} className={'callout ' + cls}>
                          <span className="callout-icon" aria-hidden>{icon}</span>
                          <div className="callout-body">
                            <p className="callout-title">{String(i2.check)} <span className="muted">({st})</span></p>
                            <p>{String(i2.reason)}</p>
                            {i2.legalRef ? <p className="muted">{String(i2.legalRef)}{i2.ruleCode ? ' [' + String(i2.ruleCode) + ']' : ''}</p> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="card card-pad">
                <p className="muted" style={{ margin: 0 }}>No compliance check has been run yet. Use <strong>Validate</strong> before submitting.</p>
              </div>
            )}
            <div className="callout">
              <span className="callout-icon" aria-hidden>⚖️</span>
              <div className="callout-body">
                <p className="callout-title">Compliance gating</p>
                <p>RED blocks approval. AMBER requires HR review before approval. The compliance engine applies the current legal framework version (Employment Act, 2006, Chapter 226, including the 2026 amendment).</p>
              </div>
            </div>
          </div>
        )}
        {tab === 'variations' && (
          <div className="stack">
            {variations.map((v) => {
              const changes = parseJson<Rec[]>(v.changes, []);
              return (
                <section key={String(v.id)} className="card def-sec">
                  <div className="def-sec-head">
                    <span className="def-sec-icon" aria-hidden>🔄</span>
                    <div>
                      <h3><span className="td-cell-mono">{String(v.variationNo ?? '')}</span> · {variationLabel(String(v.variationType ?? ''))}</h3>
                      <p>Effective {fmtDate(v.effectiveDate)}{v.newContractId ? ' · New contract #' + String(v.newContractId) : ''}</p>
                    </div>
                    <span style={{ marginLeft: 'auto' }}><Badge value={v.status} /></span>
                  </div>
                  {v.reason ? <p className="muted" style={{ margin: '0 0 10px' }}>{String(v.reason)}</p> : null}
                  {changes.length > 0 && (
                    <dl className="def-list">
                      {changes.map((ch, idx) => (
                        <DefRow key={idx} k={String(ch.label ?? ch.field ?? 'change')} v={<span><span className="muted">{String(ch.oldValue ?? '—')}</span> <span className="muted" aria-hidden>→</span> <span className="td-strong">{String(ch.newValue ?? '—')}</span></span>} />
                      ))}
                    </dl>
                  )}
                </section>
              );
            })}
            {renewals.map((r) => (
              <section key={String(r.id)} className="card def-sec">
                <div className="def-sec-head">
                  <span className="def-sec-icon" aria-hidden>📅</span>
                  <div>
                    <h3><span className="td-cell-mono">{String(r.renewalNo ?? '')}</span> · Renewal</h3>
                    <p>{fmtDate(r.newStartDate)} → {fmtDate(r.newEndDate)}</p>
                  </div>
                  <span style={{ marginLeft: 'auto' }}><Badge value={r.status} /></span>
                </div>
                {r.reason ? <p className="muted" style={{ margin: 0 }}>{String(r.reason)}{r.newContractId ? ' · New contract #' + String(r.newContractId) : ''}</p> : null}
              </section>
            ))}
            {variations.length === 0 && renewals.length === 0 && (
              <EmptyState icon="🔄" title="No variations or renewals" hint="Changes to an executed contract are recorded as formal variation documents and never rewrite the original." />
            )}
            {documents.length > 0 && (
              <section className="card def-sec">
                <div className="def-sec-head">
                  <span className="def-sec-icon" aria-hidden>📎</span>
                  <div>
                    <h3>Documents</h3>
                    <p>{documents.length} attached</p>
                  </div>
                </div>
                <dl className="def-list">
                  {documents.map((d) => (
                    <DefRow key={String(d.id)} k={String(d.documentType ?? 'document')} v={<span><span className="td-cell-mono">{String(d.documentNo ?? '')}</span>{d.mimeType ? ' · ' + String(d.mimeType) : ''} <Badge value={d.status} /></span>} />
                  ))}
                </dl>
              </section>
            )}
          </div>
        )}
        {tab === 'audit' && (
          <div>
            <div className="list-meta" style={{ marginBottom: 12 }}>
              <span className="muted">{fmtNum(audit.length)} event(s) · recorded from audit_logs</span>
              <span className="chip chip-on"><span className="chip-k">Integrity</span> tamper-resistant</span>
            </div>
            {audit.length === 0 ? (
              <EmptyState icon="🛡" title="No audit events" hint="Sensitive actions on this contract are recorded here with timestamps, user and IP." />
            ) : (
              <div className="feed">
                {audit.map((a) => {
                  const meta = auditEventMeta(String(a.action ?? ''));
                  return (
                    <div key={String(a.id)} className="feed-item">
                      <span className="feed-icon" style={{ background: hexToRgba(meta.color, 0.13), color: meta.color }} aria-hidden>{meta.icon}</span>
                      <div className="feed-body">
                        <div className="feed-title">
                          <span className="td-strong">{meta.label}</span>
                          <span className="td-cell-mono">{String(a.action ?? '')}</span>
                        </div>
                        <div className="feed-meta">
                          <span>{fmtDate(a.createdAt)}</span>
                          {a.userId ? <span> · user {String(a.userId)}</span> : null}
                          {a.ip ? <span> · {String(a.ip)}</span> : null}
                          {a.device ? <span> · {String(a.device)}</span> : null}
                          {a.metadata ? <span> · {String(a.metadata)}</span> : null}
                        </div>
                      </div>
                      <span className="muted feed-id">#{String(a.id)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {modal === 'request-sign' && (
        <Modal title="Request signature" onClose={() => setModal('')} footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== ''} onClick={doRequestSignature}>Send</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">Signatory</label>
              <select value={signerType} onChange={(e) => setSignerType(e.target.value)}>
                <option value="ALL">All pending signatories</option>
                {SIGNER_TYPES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <p className="hint">The employee can only sign their own contract; an authorised HR user signs for the employer.</p>
            </div>
          </div>
        </Modal>
      )}
      {modal === 'sign' && (
        <Modal title="Sign contract" onClose={() => setModal('')} footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-success" disabled={busy !== '' || (signerType === 'WITNESS' && !witnessName.trim())} onClick={doSign}>Sign</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">Signing as</label>
              <select value={signerType} onChange={(e) => setSignerType(e.target.value)}>
                {SIGNER_TYPES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Signature text (optional)</label>
              <input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Typed name or short text" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Signature image (optional)</label>
              <input
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                onChange={(e) => setSignatureFile(e.target.files?.[0] ?? null)}
              />
              {signatureFile && (
                <span className="hint" style={{ display: 'block', marginTop: 6 }}>
                  <img src={URL.createObjectURL(signatureFile)} alt="Signature preview" style={{ display: 'block', maxHeight: 48, maxWidth: 200 }} />
                  {signatureFile.name}
                </span>
              )}
            </div>
            {signerType === 'WITNESS' && (
              <>
                <div className="field">
                  <label className="field-required">Witness name</label>
                  <input value={witnessName} onChange={(e) => setWitnessName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Witness email</label>
                  <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} />
                </div>
              </>
            )}
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Signing records your identity, timestamp, IP and device in the audit trail. The executed document is frozen and stored separately from this draft.
            </p>
          </div>
        </Modal>
      )}
      {modal === 'variation' && (
        <Modal title="New contract variation" onClose={() => setModal('')} wide footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || varChanges.length === 0 || !varChanges[0].field} onClick={doVariation}>Create & apply</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">Variation type</label>
              <select value={variationType} onChange={(e) => setVariationType(e.target.value)}>
                {VARIATION_TYPES.map((t) => <option key={t} value={t}>{variationLabel(t)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Effective date</label>
              <input type="date" value={varEffectiveDate} onChange={(e) => setVarEffectiveDate(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Reason</label>
              <input value={varReason} onChange={(e) => setVarReason(e.target.value)} placeholder="Why is this contract changing?" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <h3>Changes</h3>
              {varChanges.map((ch, idx) => (
                <div key={idx} className="grid-4" style={{ marginBottom: 8 }}>
                  <select value={ch.field} onChange={(e) => patchVar(idx, 'field', e.target.value)}>
                    {VAR_FIELD_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  <input value={ch.oldValue} onChange={(e) => patchVar(idx, 'oldValue', e.target.value)} placeholder="Old value" />
                  <input value={ch.newValue} onChange={(e) => patchVar(idx, 'newValue', e.target.value)} placeholder="New value" />
                  <button type="button" className="btn btn-sm" onClick={() => setVarChanges(varChanges.filter((_, j) => j !== idx))}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn btn-sm" onClick={() => setVarChanges([...varChanges, { field: 'basic', oldValue: '', newValue: '' }])}>+ Add change</button>
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Applying a variation freezes the executed contract (status VARIED) and creates a new VARIATION contract carrying forward all statutory rights. The historical document is never modified.
            </p>
          </div>
        </Modal>
      )}
      {modal === 'renewal' && (
        <Modal title="New contract renewal" onClose={() => setModal('')} footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !renStart} onClick={doRenewal}>Create & apply</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">New start date</label>
              <input type="date" value={renStart} onChange={(e) => setRenStart(e.target.value)} />
            </div>
            <div className="field">
              <label>New end date</label>
              <input type="date" value={renEnd} onChange={(e) => setRenEnd(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Reason</label>
              <input value={renReason} onChange={(e) => setRenReason(e.target.value)} placeholder="Renewal reason" />
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Renewal creates a new RENEWAL contract (e.g. RNW/2026/000001) and marks the previous contract as renewed. Notice and statutory particulars carry forward unchanged.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ============================================================
// CONTRACT TEMPLATES
// ============================================================

function TemplateList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const filtered = rows.filter((t) => {
    if (q.trim()) {
      const hay = (String(t.name ?? '') + ' ' + String(t.code ?? '') + ' ' + String(t.description ?? '')).toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    if (typeFilter && String(t.contractType ?? '') !== typeFilter) return false;
    if (statusFilter === 'approved' && !t.isApproved) return false;
    if (statusFilter === 'pending' && t.isApproved) return false;
    if (statusFilter === 'active' && String(t.status ?? '') !== 'ACTIVE') return false;
    if (statusFilter === 'draft' && String(t.status ?? '') !== 'DRAFT') return false;
    return true;
  });
  useEffect(() => {
    setLoading(true);
    api<{ data: Rec[] }>('/api/ops/hr/contracts/templates')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Templates failed'))
      .finally(() => setLoading(false));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Contract templates</h1>
          <p className="muted">Approved templates drive contract generation. Mandatory statutory fields are preserved regardless of organisation customisation.</p>
        </div>
      </header>
      <ModuleTabs active="templates" />
      {error && <ErrorBanner error={error} />}
      <div className="list-meta">
        <span className="muted">{fmtNum(rows.length)} template(s)</span>
        <span className="chip chip-on"><span className="chip-k">Approved</span> {fmtNum(rows.filter((t) => t.isApproved).length)}</span>
      </div>
      <div className="toolbar">
        <input className="search-input" placeholder="Search templates by name, code or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by contract type">
          <option value="">All types</option>
          {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{contractTypeLabel(t)}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending approval</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
        </select>
      </div>
      <section>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Type</th><th>Version</th><th>Status</th><th>Approved</th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={String(t.id)} className="row-click" onClick={() => navigate('/people/contracts/templates/' + String(t.id))}>
                  <td className="td-cell-mono">{String(t.code ?? '-')}</td>
                  <td><span className="td-strong">{String(t.name ?? '')}</span><div className="muted">{String(t.description ?? '')}</div></td>
                  <td>{contractTypeLabel(String(t.contractType ?? ''))}</td>
                  <td>v{String(t.currentVersion ?? '-')}</td>
                  <td><Badge value={t.status} /></td>
                  <td>{t.isApproved ? <span className="badge badge-success">Approved</span> : <span className="badge badge-neutral">Pending</span>}</td>
                </tr>
              ))}
              {loading && rows.length === 0 ? <LoadingRow label="Loading templates…" colSpan={6} /> : filtered.length === 0 ? <tr><td colSpan={6}><EmptyState icon="🧩" title="No templates found" hint={q || typeFilter || statusFilter ? 'No templates match the current filters.' : 'Approved templates drive contract generation. Configure templates to get started.'} /></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TemplateDesk({ id }: { id: number }) {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hr/contracts/templates/' + String(id))
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Template failed'));
  }, [id]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening template" />;
  const t = (data.template ?? {}) as Rec;
  const versions = (data.versions ?? []) as Rec[];
  const activeVersion = versions.find((v) => v.status === 'ACTIVE') ?? versions[0] ?? null;
  const activeSections = activeVersion ? templateVersionSections(activeVersion) : [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>{String(t.name ?? '')} <Badge value={t.status} /></h1>
          <p className="muted">
            <span className="cell-mono">{String(t.code ?? '')}</span>
            {' \u00B7 '}{typeChip(String(t.contractType ?? ''))}
            {' · approved: '}{t.isApproved ? 'Yes' : 'No'}
          </p>
          <div className="page-meta">
            <span>Created <b>{fmtDate(t.createdAt)}</b></span>
            <span>Versions <b>{fmtNum(versions.length)}</b></span>
            <span>Approval <b>{t.isApproved ? 'Approved' : 'Pending'}</b></span>
          </div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people/contracts/templates')}>All templates</button>
        </div>
      </header>
      <ModuleTabs active="templates" />
      {error && <ErrorBanner error={error} />}
      <section className="card def-sec">
        <div className="def-sec-head">
          <span className="def-sec-icon" aria-hidden>📄</span>
          <div>
            <h3>Description</h3>
            <p>Purpose of this template and how it is applied during contract generation.</p>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>{String(t.description ?? '-')}</p>
      </section>
      <section className="card def-sec" style={{ marginTop: 12 }}>
        <div className="def-sec-head">
          <span className="def-sec-icon" aria-hidden>🗺</span>
          <div>
            <h3>Structure</h3>
            <p>{activeVersion ? 'Outline of version ' + String(activeVersion.version) + ' — the sections and clauses applied when this template generates a contract.' : 'No versions recorded for this template yet.'}</p>
          </div>
        </div>
        {activeSections.length > 0 ? (
          <div className="stack" style={{ gap: 6 }}>
            {activeSections.map((sec, si) => (
              <div key={si} className="tmpl-sec">
                <div className="tmpl-sec-head">
                  <span className="tmpl-sec-code">{sec.sectionCode || 'Unnamed section'}</span>
                  <span className="muted">{fmtNum(sec.clauses.length)} clause(s)</span>
                </div>
                <div className="chips">
                  {sec.clauses.map((code) => <span key={code} className="code-chip">{code}</span>)}
                  {sec.clauses.length === 0 && <span className="muted">No clauses in this section</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>This template version has no structured section content.</p>
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        <div className="card-head"><h3>Versions ({fmtNum(versions.length)})</h3></div>
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {versions.map((v) => {
            const secs = templateVersionSections(v);
            const clauseCount = secs.reduce((n, sec) => n + sec.clauses.length, 0);
            return (
              <div key={String(v.id)} className="card def-sec">
                <div className="def-sec-head">
                  <span className="def-sec-icon" aria-hidden>🗂</span>
                  <div>
                    <h3>Version {String(v.version)}{v.name ? ' · ' + String(v.name) : ''}</h3>
                    <p>Created {fmtDate(v.createdAt)} · {fmtNum(secs.length)} section(s) · {fmtNum(clauseCount)} clause(s)</p>
                  </div>
                  <span style={{ marginLeft: 'auto' }}><Badge value={v.status} /></span>
                </div>
                {secs.length > 0 ? (
                  <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                    {secs.map((sec, si) => (
                      <div key={si} className="tmpl-sec">
                        <div className="tmpl-sec-head">
                          <span className="tmpl-sec-code">{sec.sectionCode || 'Unnamed section'}</span>
                          <span className="muted">{fmtNum(sec.clauses.length)} clause(s)</span>
                        </div>
                        <div className="chips">
                          {sec.clauses.map((code) => <span key={code} className="code-chip">{code}</span>)}
                          {sec.clauses.length === 0 && <span className="muted">No clauses</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '10px 0 0' }}>No structured sections recorded for this version.</p>
                )}
                {(Boolean(v.header) || Boolean(v.footer)) && (
                  <div className="grid-2" style={{ marginTop: 10 }}>
                    {v.header ? <div className="tmpl-block"><span className="tmpl-block-label">Header</span><p>{String(v.header)}</p></div> : null}
                    {v.footer ? <div className="tmpl-block"><span className="tmpl-block-label">Footer</span><p>{String(v.footer)}</p></div> : null}
                  </div>
                )}
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <button className="btn btn-sm" onClick={() => setOpen(open === Number(v.id) ? null : Number(v.id))}>
                    {open === Number(v.id) ? 'Hide raw JSON' : 'Raw JSON'}
                  </button>
                </div>
                {open === Number(v.id) && (
                  <div className="code-scroll">
                    <pre>{JSON.stringify({ sections: v.sections, content: v.content, header: v.header, footer: v.footer }, null, 2)}</pre>
                  </div>
                )}
              </div>
            );
          })}
          {versions.length === 0 && <EmptyState icon="🧩" title="No versions recorded" hint="Template versions hold the section, clause and header/footer content used at generation time." />}
        </div>
      </section>
    </div>
  );
}


// ============================================================
// CLAUSE LIBRARY
// ============================================================

function requiredBadge(c: Rec) {
  const v = String(c.requiredFlag ?? c.required_flag ?? 'OPTIONAL');
  const map: Record<string, { tone: string; icon: string }> = {
    REQUIRED: { tone: 'badge-green', icon: '✓' },
    CONDITIONAL: { tone: 'badge-amber', icon: '⚠' },
    OPTIONAL: { tone: 'badge-blue', icon: '●' },
  };
  const m = map[v] ?? { tone: 'badge-neutral', icon: '●' };
  return <span className={`badge ${m.tone}`}><span className="badge-icon" aria-hidden>{m.icon}</span>{v}</span>;
}

function enforcementBadge(r: Rec) {
  const v = String(r.enforcement ?? 'HARD');
  const map: Record<string, { tone: string; icon: string }> = {
    HARD: { tone: 'badge-red', icon: '✕' },
    SOFT: { tone: 'badge-amber', icon: '⚠' },
    ADVISORY: { tone: 'badge-blue', icon: '●' },
  };
  const m = map[v] ?? { tone: 'badge-neutral', icon: '●' };
  return <span className={`badge ${m.tone}`}><span className="badge-icon" aria-hidden>{m.icon}</span>{v}</span>;
}

function validationBadge(v: unknown) {
  const val = String(v ?? 'DRAFT');
  const map: Record<string, { tone: string; icon: string }> = {
    VALIDATED: { tone: 'badge-green', icon: '✓' },
    PENDING_REVIEW: { tone: 'badge-amber', icon: '⚠' },
    REJECTED: { tone: 'badge-red', icon: '✕' },
    DRAFT: { tone: 'badge-neutral', icon: '●' },
  };
  const m = map[val] ?? { tone: 'badge-neutral', icon: '●' };
  return <span className={`badge ${m.tone}`}><span className="badge-icon" aria-hidden>{m.icon}</span>{val}</span>;
}

function ClauseLibrary() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState('');
  const [busy, setBusy] = useState(false);
  const [versionTarget, setVersionTarget] = useState<Rec | null>(null);
  const [form, setForm] = useState<Rec>({});
  const patchForm = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const load = useCallback(() => {
    setError('');
    setLoading(true);
    const p: string[] = [];
    if (category) p.push('category=' + encodeURIComponent(category));
    if (q.trim()) p.push('q=' + encodeURIComponent(q.trim()));
    api<{ data: Rec[] }>('/api/ops/hr/contracts/clauses?' + p.join('&'))
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Clauses failed'))
      .finally(() => setLoading(false));
  }, [category, q]);
  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm({
      clauseCode: '', name: '', category: 'General', text: '', requiredFlag: 'OPTIONAL',
      effectiveFrom: '', effectiveTo: '', applicableContractTypes: '',
    });
    setModal('new');
  };
  const openVersion = (c: Rec) => {
    setVersionTarget(c);
    setForm({
      name: String(c.name ?? ''),
      category: String(c.category ?? 'General'),
      text: String(c.text ?? ''),
      effectiveFrom: String(c.effectiveFrom ?? ''),
      effectiveTo: String(c.effectiveTo ?? ''),
    });
    setModal('version');
  };
  const doCreate = () => {
    setBusy(true);
    setError('');
    const body: Rec = {
      clauseCode: String(form.clauseCode ?? '').toUpperCase(),
      name: form.name,
      category: form.category,
      text: form.text,
      requiredFlag: form.requiredFlag,
      effectiveFrom: form.effectiveFrom ? String(form.effectiveFrom) : undefined,
      effectiveTo: form.effectiveTo ? String(form.effectiveTo) : undefined,
      applicableContractTypes: String(form.applicableContractTypes ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    api<{ data: Rec }>('/api/ops/hr/contracts/clauses', { method: 'POST', body: JSON.stringify(body) })
      .then(() => { setModal(''); load(); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Create failed'))
      .finally(() => setBusy(false));
  };
  const doVersion = () => {
    if (!versionTarget) return;
    setBusy(true);
    setError('');
    const body: Rec = {
      name: form.name,
      category: form.category,
      text: form.text,
      status: 'ACTIVE',
      effectiveFrom: form.effectiveFrom ? String(form.effectiveFrom) : undefined,
      effectiveTo: form.effectiveTo ? String(form.effectiveTo) : null,
    };
    api<{ data: Rec }>('/api/ops/hr/contracts/clauses/' + String(versionTarget.id) + '/versions', { method: 'POST', body: JSON.stringify(body) })
      .then(() => { setModal(''); setVersionTarget(null); load(); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Version failed'))
      .finally(() => setBusy(false));
  };
  const isStatutory = (c: Rec) => c.legalRuleId != null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Clause library</h1>
          <p className="muted">Versioned clauses feed the rule engine. Statutory clauses are centrally controlled; tenant clauses are versioned locally and re-validated on change.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.contracts.create') && (
            <button className="btn btn-primary" onClick={openNew}>New clause</button>
          )}
        </div>
      </header>
      <ModuleTabs active="clauses" />
      {error && <ErrorBanner error={error} />}
      <section>
        <div className="toolbar">
          <input className="search-input" placeholder="Search clauses" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={load}>Apply</button>
        </div>
        <div className="list-meta">
          <span className="muted">{fmtNum(rows.length)} clause(s)</span>
          {(category || q.trim()) && (
            <div className="chips">
              {category && <button className="chip" onClick={() => setCategory('')}>Category: {category} <span className="chip-x" aria-hidden>✕</span></button>}
              {q.trim() && <button className="chip" onClick={() => setQ('')}>Search &ldquo;{q.trim()}&rdquo; <span className="chip-x" aria-hidden>✕</span></button>}
            </div>
          )}
        </div>
        <div className="chips" style={{ margin: '12px 0' }}>
          <button className={category === '' ? 'chip chip-active' : 'chip'} onClick={() => setCategory('')}>All</button>
          {CLAUSE_CATEGORIES.map((cat) => (
            <button key={cat} className={category === cat ? 'chip chip-active' : 'chip'} onClick={() => setCategory(cat)}>{cat}</button>
          ))}
        </div>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Category</th><th>Required</th><th>Version</th><th>Effective</th><th>Validation</th><th>Status</th><th>Governance</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={String(c.id)}>
                  <td className="td-cell-mono">{String(c.clauseCode ?? '-')}</td>
                  <td><span className="td-strong">{String(c.name ?? '')}</span><div className="muted">
                    {String(c.law ?? '')}{c.lawChapter ? ' (' + String(c.lawChapter) + ')' : ''}{c.section ? ' · ' + String(c.section) : ''}
                    {c.legalRuleName ? ' · ' + String(c.legalRuleName) : ''}
                    {c.lawSource ? ' · ' + String(c.lawSource) : ''}
                  </div></td>
                  <td>{String(c.category ?? '')}</td>
                  <td>{requiredBadge(c)}</td>
                  <td>v{String(c.version ?? 1)}</td>
                  <td>{fmtDate(c.effectiveFrom)}{c.effectiveTo ? ' → ' + fmtDate(c.effectiveTo) : ''}</td>
                  <td>{validationBadge(c.validationStatus)}</td>
                  <td><Badge value={c.status} /></td>
                  <td>
                    {isStatutory(c) ? (
                      <span className="badge badge-blue"><span className="badge-icon" aria-hidden>⚖</span>Statutory · locked</span>
                    ) : can(user, 'hr.contracts.create') ? (
                      <button className="btn btn-sm" onClick={() => openVersion(c)}>New version</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {loading && rows.length === 0 ? <LoadingRow label="Loading clauses…" colSpan={9} /> : rows.length === 0 ? <tr><td colSpan={9}><EmptyState icon="🗂" title="No clauses match" hint="Try a different category or search term." /></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {modal === 'new' && (
        <Modal title="New clause" onClose={() => setModal('')} wide footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !String(form.clauseCode ?? '').trim() || !String(form.name ?? '').trim() || !String(form.text ?? '').trim()} onClick={doCreate}>Create clause</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">Clause code</label>
              <input value={String(form.clauseCode ?? '')} onChange={(e) => patchForm('clauseCode', e.target.value.toUpperCase())} placeholder="e.g. MOBILE_ALLOWANCE" />
            </div>
            <div className="field">
              <label className="field-required">Name</label>
              <input value={String(form.name ?? '')} onChange={(e) => patchForm('name', e.target.value)} />
            </div>
            <div className="field">
              <label className="field-required">Category</label>
              <select value={String(form.category ?? 'General')} onChange={(e) => patchForm('category', e.target.value)}>
                {CLAUSE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-required">Required</label>
              <select value={String(form.requiredFlag ?? 'OPTIONAL')} onChange={(e) => patchForm('requiredFlag', e.target.value)}>
                {['REQUIRED', 'OPTIONAL', 'CONDITIONAL'].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Effective from</label>
              <input type="date" value={String(form.effectiveFrom ?? '')} onChange={(e) => patchForm('effectiveFrom', e.target.value)} />
            </div>
            <div className="field">
              <label>Effective to</label>
              <input type="date" value={String(form.effectiveTo ?? '')} onChange={(e) => patchForm('effectiveTo', e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Applicable contract types</label>
              <input value={String(form.applicableContractTypes ?? '')} onChange={(e) => patchForm('applicableContractTypes', e.target.value)} placeholder="Comma separated, e.g. PERMANENT, FIXED_TERM" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="field-required">Clause text</label>
              <textarea rows={6} value={String(form.text ?? '')} onChange={(e) => patchForm('text', e.target.value)} placeholder="Full clause wording used when the contract is assembled." />
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Tenant-authored clauses are not statutory content: they start as PENDING_REVIEW and must be re-validated by the compliance engine before use. Statutory clauses cannot be created or modified by tenants.
            </p>
          </div>
        </Modal>
      )}
      {modal === 'version' && versionTarget && (
        <Modal title={'New version · ' + String(versionTarget.clauseCode ?? '')} onClose={() => setModal('')} wide footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !String(form.name ?? '').trim() || !String(form.text ?? '').trim()} onClick={doVersion}>Save version {Number(versionTarget.version ?? 1) + 1}</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field">
              <label className="field-required">Name</label>
              <input value={String(form.name ?? '')} onChange={(e) => patchForm('name', e.target.value)} />
            </div>
            <div className="field">
              <label className="field-required">Category</label>
              <select value={String(form.category ?? 'General')} onChange={(e) => patchForm('category', e.target.value)}>
                {CLAUSE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Effective from</label>
              <input type="date" value={String(form.effectiveFrom ?? '')} onChange={(e) => patchForm('effectiveFrom', e.target.value)} />
            </div>
            <div className="field">
              <label>Effective to</label>
              <input type="date" value={String(form.effectiveTo ?? '')} onChange={(e) => patchForm('effectiveTo', e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="field-required">Clause text</label>
              <textarea rows={8} value={String(form.text ?? '')} onChange={(e) => patchForm('text', e.target.value)} />
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Creating a version snapshots the current wording into the history table and marks the new wording PENDING_REVIEW until it is re-validated.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// LEGAL RULES (legal framework manager read view)
// ============================================================

function LegalRules() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api<{ data: Rec[] }>('/api/ops/hr/contracts/legal-rules')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Legal rules failed'))
      .finally(() => setLoading(false));
  }, []);
  const written = rows.filter((r) => String(r.code ?? '') === 'WRITTEN_PARTICULARS');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Legal framework</h1>
          <p className="muted">Versioned legal rules from the Employment Act, 2006 (Chapter 226, Laws of Uganda), including the Employment (Amendment) Act, 2026. Rules are configuration, not hard-coded assumptions.</p>
        </div>
      </header>
      <ModuleTabs active="rules" />
      {error && <ErrorBanner error={error} />}
      {written.length > 0 && (
        <div className="callout">
          <span className="callout-icon" aria-hidden>⚖</span>
          <div className="callout-body">
            <p className="callout-title">WRITTEN_PARTICULARS enforced</p>
            <p>Section 59 written particulars are enforced by the compliance engine: employer identity, employee identity, start date, job title, workplace, compensation, payment interval, working hours, leave and notice must all be present before approval.</p>
          </div>
        </div>
      )}
      <div className="list-meta">
        <span className="muted">{fmtNum(rows.length)} legal rule(s) configured</span>
        <span className="chip chip-on"><span className="chip-k">Enforced</span> {fmtNum(rows.filter((r) => String(r.enforcement ?? 'HARD') !== 'ADVISORY').length)} mandatory</span>
      </div>
      <section>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Law</th><th>Section</th><th>Source</th><th>Version</th><th>Enforcement</th><th>Effective</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  <td className="td-cell-mono">{String(r.code ?? '-')}</td>
                  <td><span className="td-strong">{String(r.name ?? '')}</span><div className="muted">{String(r.description ?? '')}</div></td>
                  <td>{String(r.law ?? '')}{r.lawChapter ? <span className="muted"> ({String(r.lawChapter)})</span> : null}</td>
                  <td>{r.section && String(r.section) !== '-' ? String(r.section) : <span className="muted">–</span>}</td>
                  <td>{r.source ? <span className="muted">{String(r.source)}</span> : <span className="muted">–</span>}</td>
                  <td>v{String(r.version ?? 1)}</td>
                  <td>{enforcementBadge(r)}</td>
                  <td>{fmtDate(r.effectiveFrom)}{r.effectiveTo ? ' → ' + fmtDate(r.effectiveTo) : ''}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {loading && rows.length === 0 ? <LoadingRow label="Loading legal rules…" colSpan={9} /> : rows.length === 0 ? <tr><td colSpan={9}><EmptyState icon="⚖" title="No legal rules configured" hint="Legal rules are versioned configuration from the Employment Act, 2006 (Chapter 226)." /></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}


// ============================================================
// SMART LISTS (expiring / probation ending)
// ============================================================

function SmartList({ kind }: { kind: 'expiring' | 'probation' }) {
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setError('');
    setLoading(true);
    const p = kind === 'expiring' ? '/api/ops/hr/contracts/expiring?days=' + days : '/api/ops/hr/contracts/probation-ending?days=' + days;
    api<{ data: { items: Rec[]; total: number } }>(p)
      .then((r) => { setItems(r.data.items ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'List failed'))
      .finally(() => setLoading(false));
  }, [kind, days]);
  useEffect(() => { load(); }, [load]);
  const isProbation = kind === 'probation';
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>{isProbation ? 'Probation ending' : 'Expiring contracts'}</h1>
          <p className="muted">
            {isProbation
              ? 'Employees whose probation period ends within the selected window. Confirm, extend where legally permissible, or end employment.'
              : 'Fixed-term and temporary contracts expiring within the selected window. Reminder cadence: 90/60/30/14/7 days before expiry.'}
          </p>
        </div>
      </header>
      <ModuleTabs active={isProbation ? 'probation' : 'expiring'} />
      {error && <ErrorBanner error={error} />}
      <section>
        <div className="toolbar">
          <label>Window</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
        <div className="list-meta">
          <span className="muted">{fmtNum(total)} contract(s) in this window</span>
          <span className="chip chip-on"><span className="chip-k">{isProbation ? 'Probation ends' : 'Expires'}</span> within {days} days</span>
        </div>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Contract</th><th>Employee</th><th>Type</th><th>Status</th>
                <th>{isProbation ? 'Probation ends' : 'Expires'}</th><th>Start</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={String(c.id)} className="row-click" onClick={() => navigate('/people/contracts/' + String(c.id))}>
                  <td className="td-cell-mono">{String(c.contractNo ?? '-')}</td>
                  <td><Avatar name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')} sub={String(c.jobTitle ?? '')} size="sm" /></td>
                  <td>{contractTypeLabel(String(c.contractType ?? ''))}</td>
                  <td><Badge value={c.status} /></td>
                  <td>{fmtDate(isProbation ? c.probationEndDate : c.endDate)}</td>
                  <td>{fmtDate(c.startDate)}</td>
                </tr>
              ))}
              {loading && items.length === 0 ? <LoadingRow label="Loading…" colSpan={6} /> : items.length === 0 ? <tr><td colSpan={6}><EmptyState icon="📭" title="Nothing in this window" hint="No contracts match the selected window. Try widening it or checking back later." /></td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={1} pageSize={100} total={total} onPage={() => undefined} />
      </section>
    </div>
  );
}

// ============================================================
// MISSING PARTICULARS
// ============================================================

function MissingParticulars() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api<{ data: Rec[] }>('/api/ops/hr/contracts/missing-particulars')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Missing particulars failed'))
      .finally(() => setLoading(false));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Missing written particulars</h1>
          <p className="muted">Contracts missing statutory particulars required by the Employment Act, 2006 (Chapter 226) s.59. These cannot be approved until corrected.</p>
        </div>
      </header>
      <ModuleTabs active="missing" />
      {error && <ErrorBanner error={error} />}
      <div className="list-meta">
        <span className="muted">{fmtNum(rows.length)} contract(s) with missing particulars</span>
        <span className="chip chip-on"><span className="chip-k">Blocked from</span> approval</span>
      </div>
      <section>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr><th>Contract</th><th>Employee</th><th>Status</th><th>Missing</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={String(c.id)} className="row-click" onClick={() => navigate('/people/contracts/' + String(c.id))}>
                  <td className="td-cell-mono">{String(c.contractNo ?? '-')}</td>
                  <td><Avatar name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')} sub={String(c.jobTitle ?? '')} size="sm" /></td>
                  <td><Badge value={c.status} /></td>
                  <td>
                    {(c.missing as string[] ?? []).map((m) => (
                      <span key={m} className="badge badge-red" style={{ marginRight: 4 }}>{m}</span>
                    ))}
                  </td>
                </tr>
              ))}
              {loading && rows.length === 0 ? <LoadingRow label="Loading…" colSpan={4} /> : rows.length === 0 ? <tr><td colSpan={4}><EmptyState icon="✓" title="All particulars in place" hint="No in-progress contracts are missing mandatory written particulars." /></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// MY CONTRACTS (employee self-service)
// ============================================================

function MyContracts() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [signId, setSignId] = useState<number | null>(null);
  const [signature, setSignature] = useState('');
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [executed, setExecuted] = useState<{ secret: string; verificationCode: string } | null>(null);
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/hr/contracts/my?pageSize=50')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'My contracts failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening your contracts" />;
  const items = (data.items ?? []) as Rec[];
  const doSign = async () => {
    if (signId === null) return;
    setBusy('sign'); setNotice('');
    const body: Rec = { signerType: 'EMPLOYEE', signature: signature.trim() || undefined };
    if (signatureFile) {
      const fd = new FormData();
      fd.append('file', signatureFile);
      fd.append('signerType', 'EMPLOYEE');
      try {
        const up = await api<{ data: { url: string } }>('/api/ops/hr/contracts/' + String(signId) + '/signature-image', { method: 'POST', body: fd });
        body.signatureUrl = up.data.url;
      } catch (e) {
        setBusy('');
        setError(e instanceof Error ? e.message : 'Signature image upload failed');
        return;
      }
    }
    api<{ data: Rec }>('/api/ops/hr/contracts/' + String(signId) + '/sign', {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then((r) => {
        setBusy('');
        setSignId(null);
        setSignature('');
        setSignatureFile(null);
        if (r.data.executed) {
          setExecuted({ secret: String(r.data.secret ?? ''), verificationCode: String(r.data.verificationCode ?? '') });
          setNotice('Contract fully executed. Keep the verification details safe.');
        } else {
          setNotice('Signature recorded. Status: ' + String(r.data.status));
        }
        load();
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(''); });
  };
  const downloadPdf = async (c: Rec) => {
    try {
      await openDocument('employment-contract', c.id, 'pdf', String(c.contractNo ?? 'contract') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const printContract = async (c: Rec) => {
    try {
      await openDocument('employment-contract', c.id, 'print', String(c.contractNo ?? 'contract') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const pending = items.filter((c) => ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'].includes(String(c.status ?? '')));
  const current = items.find((c) => ['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(c.status ?? ''))) ?? items[0] ?? null;
  const activeCount = items.filter((c) => ['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(c.status ?? ''))).length;
  const lcIdx = current ? lifecycleIndex(String(current.status ?? '')) : -1;
  const currentPending = current ? ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'].includes(String(current.status ?? '')) : false;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Employee self-service</p>
          <h1>My employment contracts</h1>
          <p className="muted">View, print, download and sign your own contracts. Printed copies include every attached clause. You can only sign contracts that are addressed to you.</p>
        </div>
        <div className="head-actions">
          {pending.length > 0 && (
            <button className="chip chip-active" onClick={() => { const el = document.getElementById('sig-required'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>
              ✎ {fmtNum(pending.length)} awaiting signature
            </button>
          )}
        </div>
      </header>
      {notice && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>✓</span>
          <div className="callout-body">
            <p className="callout-title">Success</p>
            <p>{notice}</p>
          </div>
        </div>
      )}
      {error && <ErrorBanner error={error} />}
      {executed && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>✓</span>
          <div className="callout-body">
            <p className="callout-title">Contract fully executed</p>
            <p>Verification details (one-time) — keep them safe for document verification.</p>
            <p style={{ marginTop: 8 }}>Secret: <code className="code-chip">{executed.secret}</code></p>
            <p>Verification code: <code className="code-chip">{executed.verificationCode}</code></p>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div id="sig-required" className="callout callout-warn">
          <span className="callout-icon" aria-hidden>✎</span>
          <div className="callout-body">
            <p className="callout-title">Signature required</p>
            <p><strong>{pending.length} contract(s)</strong> are awaiting your signature. Sign to complete execution.</p>
          </div>
        </div>
      )}
      <div className="self-stats">
        <div className="self-stat">
          <span className="self-stat-icon" style={tileStyle('#1261A0', 'rgba(18,97,160,0.12)')} aria-hidden>📄</span>
          <div>
            <span className="self-stat-num">{fmtNum(items.length)}</span>
            <span className="self-stat-k">Contracts on file</span>
          </div>
        </div>
        <div className="self-stat">
          <span className="self-stat-icon" style={tileStyle('#168A5B', 'rgba(22,138,91,0.12)')} aria-hidden>✓</span>
          <div>
            <span className="self-stat-num">{fmtNum(activeCount)}</span>
            <span className="self-stat-k">Active / executed</span>
          </div>
        </div>
        <div className="self-stat">
          <span className="self-stat-icon" style={tileStyle('#D99A00', 'rgba(217,154,0,0.12)')} aria-hidden>✎</span>
          <div>
            <span className="self-stat-num">{fmtNum(pending.length)}</span>
            <span className="self-stat-k">Awaiting signature</span>
          </div>
        </div>
      </div>
      {current && (
        <section className="self-hero" aria-label="Current contract summary">
          <div>
            <div className="self-hero-top">
              <h2 className="self-hero-title">My employment contract</h2>
              <span className="cell-mono">{String(current.contractNo ?? '-')}</span>
              {typeChip(String(current.contractType ?? ''))}
              <Badge value={current.status} />
              <span className="muted">v{String(current.version ?? 1)}</span>
            </div>
            <p className="self-hero-sub">
              {String(current.jobTitle ?? '-')}
              {current.departmentName ? ' · ' + String(current.departmentName) : ''}
              {current.branchName ? ' · ' + String(current.branchName) : ''}
            </p>
            <div className="self-hero-grid">
              <div className="self-hero-fact"><span className="self-hero-k">Contract type</span><span className="self-hero-v">{contractTypeLabel(String(current.contractType ?? ''))}</span></div>
              <div className="self-hero-fact"><span className="self-hero-k">Start date</span><span className="self-hero-v">{fmtDate(current.startDate)}</span></div>
              <div className="self-hero-fact"><span className="self-hero-k">End date</span><span className="self-hero-v">{fmtDate(current.endDate)}</span></div>
              <div className="self-hero-fact"><span className="self-hero-k">Gross salary</span><span className="self-hero-v">{fmtMoney(current.grossSalary)} <span className="muted">· {String(current.currency ?? 'UGX')} · {String(current.salaryFrequency ?? 'MONTHLY').toLowerCase()}</span></span></div>
              <div className="self-hero-fact"><span className="self-hero-k">Probation</span><span className="self-hero-v">{current.probationEndDate ? fmtDate(current.probationStartDate) + ' → ' + fmtDate(current.probationEndDate) : <span className="muted">Not applicable</span>}</span></div>
              <div className="self-hero-fact"><span className="self-hero-k">Legal framework</span><span className="self-hero-v">{String(current.legalFrameworkVersion ?? '-')}</span></div>
            </div>
            <ol className="lifecycle" aria-label="Contract lifecycle" style={{ marginTop: 18, marginBottom: 0 }}>
              {LIFECYCLE.map(([label], i) => {
                const done = i < lcIdx;
                const cur = i === lcIdx;
                return (
                  <li key={label} className={'lc-step' + (done ? ' done' : '') + (cur ? ' current' : '')}>
                    <span className="lc-dot" aria-hidden>{done ? '✓' : String(i + 1)}</span>
                    <span className="lc-label">{label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="self-hero-side">
            <div className="self-hero-actions">
              {currentPending && <button className="btn btn-success" disabled={busy !== ''} onClick={() => setSignId(Number(current.id))}>Sign now</button>}
              {['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(current.status ?? '')) && (
                <>
                  <button className="btn" disabled={busy !== ''} onClick={() => printContract(current)}>Print</button>
                  <button className="btn" disabled={busy !== ''} onClick={() => downloadPdf(current)}>Download PDF</button>
                </>
              )}
            </div>
            {currentPending ? (
              <span className="chip chip-on"><span className="chip-k">Next action</span> sign to complete</span>
            ) : (
              <span className="chip chip-on"><span className="chip-k">Status</span> {String(current.status ?? '').toLowerCase().replace(/_/g, ' ')}</span>
            )}
          </div>
        </section>
      )}
      <section>
        <h2 className="self-sec-title">All contracts on file</h2>
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr><th>Contract</th><th>Type</th><th>Status</th><th>Start</th><th>End</th><th>Gross</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const dEnd = daysUntil(c.endDate);
                return (
                  <tr key={String(c.id)}>
                    <td>
                      <span className="cell-mono">{String(c.contractNo ?? '-')}</span>{' '}
                      <span className="reg-version">v{String(c.version ?? 1)}</span>
                    </td>
                    <td>{typeChip(String(c.contractType ?? ''))}</td>
                    <td><Badge value={c.status} /></td>
                    <td>{fmtD(c.startDate)}</td>
                    <td className="expiry-cell">
                      {c.endDate ? (
                        <>
                          <span>{fmtD(c.endDate)}</span>
                          {dEnd !== null && dEnd <= 30
                            ? <span className="pill pill-danger">{dEnd < 0 ? 'expired' : dEnd + 'd'}</span>
                            : dEnd !== null && dEnd <= 90 ? <span className="pill pill-warn">{dEnd + 'd'}</span> : null}
                        </>
                      ) : <span className="muted">Open</span>}
                    </td>
                    <td className="td-strong">
                      {c.grossSalary ? (<>{fmtUGX(c.grossSalary, c.currency)} <span className="muted">· {String(c.salaryFrequency ?? 'MONTHLY').toLowerCase()}</span></>) : <span className="muted">Not set</span>}
                    </td>
                    <td className="row-actions">
                      {['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'].includes(String(c.status ?? '')) && (
                        <button className="btn btn-sm btn-success" disabled={busy !== ''} onClick={() => setSignId(Number(c.id))}>Sign</button>
                      )}
                      {['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(c.status ?? '')) && (
                        <>
                          <button className="btn btn-sm" onClick={() => printContract(c)}>Print</button>
                          <button className="btn btn-sm" onClick={() => downloadPdf(c)}>Download</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && <tr><td colSpan={7}><EmptyState icon="📄" title="No contracts on file" hint="There are no employment contracts for your employee record yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {signId !== null && (
        <Modal title="Sign your contract" onClose={() => setSignId(null)} footer={
          <div className="row-actions">
            <button className="btn" onClick={() => setSignId(null)}>Cancel</button>
            <button className="btn btn-success" disabled={busy !== ''} onClick={doSign}>Sign</button>
          </div>
        }>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Signature text (optional)</label>
              <input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Type your full name to sign" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Signature image (optional)</label>
              <input
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                onChange={(e) => setSignatureFile(e.target.files?.[0] ?? null)}
              />
              {signatureFile && (
                <span className="hint" style={{ display: 'block', marginTop: 6 }}>
                  <img src={URL.createObjectURL(signatureFile)} alt="Signature preview" style={{ display: 'block', maxHeight: 48, maxWidth: 200 }} />
                  {signatureFile.name}
                </span>
              )}
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              Signing records your identity, timestamp, IP and device. Once both employee and employer have signed, the contract is executed and cannot be silently changed.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ============================================================
// CERTIFICATE OF SERVICE
// ============================================================

function Certificates() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [contracts, setContracts] = useState<Rec[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [contractId, setContractId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [natureOfBusiness, setNatureOfBusiness] = useState('');
  const [position, setPosition] = useState('');
  const [wagesAtTermination, setWagesAtTermination] = useState('');
  const [reasonForTermination, setReasonForTermination] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [issued, setIssued] = useState<Rec | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const errorRef = useRef<HTMLDivElement | null>(null);
  const skipErrorScroll = useRef(false);
  useEffect(() => {
    if (!error) return;
    if (skipErrorScroll.current) { skipErrorScroll.current = false; return; }
    if (errorRef.current) errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [error]);
  const clearFieldError = (k: string) =>
    setFieldErrors((prev) => {
      if (!prev[k]) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  const preselect = useMemo(() => {
    const q = currentQuery();
    const c = q.get('contract');
    return c ? Number(c) : null;
  }, []);
  useEffect(() => {
    api<{ data: { items: Rec[] } }>('/api/ops/hr/employees?pageSize=200')
      .then((r) => setEmployees(r.data.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
    api<{ data: { items: Rec[] } }>('/api/ops/hr/contracts?pageSize=100')
      .then((r) => setContracts(r.data.items ?? []))
      .catch(() => undefined);
    if (preselect) setContractId(String(preselect));
  }, [preselect]);
  const downloadCert = async () => {
    if (!issued) return;
    try {
      await openDocument('certificate-of-service', issued.id, 'pdf', String(issued.certNo ?? 'certificate-of-service') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const printCert = async () => {
    if (!issued) return;
    try {
      await openDocument('certificate-of-service', issued.id, 'print', String(issued.certNo ?? 'certificate-of-service') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const submit = () => {
    const fe: Record<string, string> = {};
    if (!employeeId) fe.employee = 'Select the employee the certificate covers.';
    if (!periodStart) fe.periodStart = 'Period start is required for the statutory certificate.';
    if (!periodEnd) fe.periodEnd = 'Period end is required for the statutory certificate.';
    if (Object.keys(fe).length) {
      setFieldErrors(fe);
      skipErrorScroll.current = true;
      setError('Complete the highlighted fields to issue the certificate.');
      const first = (['employee', 'periodStart', 'periodEnd'] as const).find((k) => fe[k]);
      if (first) {
        const el = document.getElementById('cert-field-' + first);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    setFieldErrors({});
    setBusy('create'); setError(''); setNotice('');
    api<{ data: Rec }>('/api/ops/hr/contracts/certificates', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: Number(employeeId),
        contractId: contractId ? Number(contractId) : undefined,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        natureOfBusiness: natureOfBusiness.trim() || undefined,
        position: position.trim() || undefined,
        wagesAtTermination: wagesAtTermination ? Number(wagesAtTermination) : undefined,
        reasonForTermination: reasonForTermination.trim() || undefined,
      }),
    })
      .then((r) => {
        setBusy('issue');
        api<{ data: Rec }>('/api/ops/hr/contracts/certificates/' + String(r.data.id) + '/issue', { method: 'POST', body: '{}' })
          .then((r2) => {
            setBusy('');
            setIssued(r2.data);
            setNotice('Certificate ' + String(r2.data.certNo ?? '') + ' issued.');
          })
          .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(''); });
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(''); });
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR &amp; payroll</p>
          <h1>Certificate of service</h1>
          <p className="muted">The statutory certificate under the Employment Act, 2006 (Chapter 226) records employer, employee, the nature of the business, the period of continuous employment, the final position and wages payable at termination.</p>
        </div>
      </header>
      <ModuleTabs active="certificates" />
      <div ref={errorRef}>
        {error && <ErrorBanner error={error} />}
      </div>
      {notice && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>✅</span>
          <div className="callout-body">
            <p className="callout-title">Success</p>
            <p>{notice}</p>
          </div>
        </div>
      )}
      {issued && (
        <div className="callout callout-success">
          <span className="callout-icon" aria-hidden>📄</span>
          <div className="callout-body">
            <p className="callout-title">Certificate issued <code className="code-chip">{String(issued.certNo ?? '')}</code></p>
            <p>Download the statutory certificate of service as a PDF for the employee record.</p>
            <div className="callout-actions">
              <button className="btn btn-sm" onClick={printCert}>Print</button>
              <button className="btn btn-sm" onClick={downloadCert}>Download PDF</button>
            </div>
          </div>
        </div>
      )}
            <section className="stack">
        <div className="def-sec">
          <div className="def-sec-head">
            <span className="def-sec-icon" aria-hidden>👤</span>
            <div>
              <h3>Employee &amp; contract</h3>
              <p>Who the certificate covers, with an optional contract reference.</p>
            </div>
          </div>
          <div className="form-grid">
            <div id="cert-field-employee" className={'field' + (fieldErrors.employee ? ' field-invalid' : '')}>
              <label className="field-required">Employee</label>
              <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); clearFieldError('employee'); }}>
                <option value="">Select employee</option>
                {employees.map((em) => (
                  <option key={String(em.id)} value={String(em.id)}>
                    {String(em.firstName ?? em.first_name ?? '') + ' ' + String(em.lastName ?? em.last_name ?? '')} ({String(em.employeeNo ?? em.employee_no ?? '')})
                  </option>
                ))}
              </select>
              {fieldErrors.employee ? <p className="field-error">{fieldErrors.employee}</p> : null}
            </div>
            <div className="field">
              <label>Employment contract (optional)</label>
              <select value={contractId} onChange={(e) => setContractId(e.target.value)}>
                <option value="">No contract reference</option>
                {contracts.map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {String(c.contractNo ?? c.contract_no ?? '')} - {String(c.firstName ?? c.first_name ?? '') + ' ' + String(c.lastName ?? c.last_name ?? '')}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="def-sec">
          <div className="def-sec-head">
            <span className="def-sec-icon" aria-hidden>📄</span>
            <div>
              <h3>Statutory particulars</h3>
              <p>Details recorded on the certificate under the Employment Act, 2006.</p>
            </div>
          </div>
          <div className="form-grid">
            <div id="cert-field-periodStart" className={'field' + (fieldErrors.periodStart ? ' field-invalid' : '')}>
              <label className="field-required">Period start</label>
              <input type="date" value={periodStart} onChange={(e) => { setPeriodStart(e.target.value); clearFieldError('periodStart'); }} />
              {fieldErrors.periodStart ? <p className="field-error">{fieldErrors.periodStart}</p> : null}
            </div>
            <div id="cert-field-periodEnd" className={'field' + (fieldErrors.periodEnd ? ' field-invalid' : '')}>
              <label className="field-required">Period end</label>
              <input type="date" value={periodEnd} onChange={(e) => { setPeriodEnd(e.target.value); clearFieldError('periodEnd'); }} />
              {fieldErrors.periodEnd ? <p className="field-error">{fieldErrors.periodEnd}</p> : null}
            </div>
            <div className="field">
              <label>Nature of employer&apos;s business</label>
              <input value={natureOfBusiness} onChange={(e) => setNatureOfBusiness(e.target.value)} placeholder="e.g. Retail, manufacturing, services" />
            </div>
            <div className="field">
              <label>Capacity / position</label>
              <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Final position held" />
            </div>
            <div className="field">
              <label>Wages payable at termination</label>
              <input type="number" value={wagesAtTermination} onChange={(e) => setWagesAtTermination(e.target.value)} placeholder="UGX" />
            </div>
            <div className="field">
              <label>Reason for termination (optional)</label>
              <input value={reasonForTermination} onChange={(e) => setReasonForTermination(e.target.value)} placeholder="Only if requested by the employee" />
            </div>
            <div className="callout" style={{ gridColumn: '1 / -1' }}>
              <span className="callout-icon" aria-hidden>⚠️</span>
              <div className="callout-body">
                <p className="callout-title">Statutory certificate of service</p>
                <p>This certificate is distinct from an optional performance reference or character reference, which is governed by separate policy.</p>
              </div>
            </div>
          </div>
        </div>
        <div className="def-sec">
          {Object.keys(fieldErrors).length > 0 && (
            <div className="callout callout-error" style={{ marginBottom: 12 }}>
              <span className="callout-icon" aria-hidden>⚠</span>
              <div className="callout-body">
                <p className="callout-title">Check the highlighted fields</p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {Object.entries(fieldErrors).map(([k, msg]) => (
                    <li key={k}>{msg}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="row-actions">
            <button className="btn btn-primary" disabled={busy !== '' || !(can(user, 'hr.certificates.issue') || can(user, 'hr.certificates.create'))} onClick={submit}>
              {busy === 'create' ? 'Creating...' : busy === 'issue' ? 'Issuing...' : 'Create &amp; issue certificate'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
