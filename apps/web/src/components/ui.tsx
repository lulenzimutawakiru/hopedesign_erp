import { useEffect, useState, type ReactNode } from 'react';
import { getToken } from '../api';

export type StatusKind =
  | 'ok'
  | 'progress'
  | 'pending'
  | 'reject'
  | 'draft'
  | 'hold'
  | 'critical'
  | 'info'
  | 'secure'
  | 'neutral';

export function statusMeta(status: string | null | undefined): {
  kind: StatusKind;
  tone: string;
  icon: string;
  label: string;
} {
  const raw = String(status ?? '');
  const s = raw.toUpperCase();
  const label = raw.replace(/_/g, ' ');
  if (['APPROVED', 'COMPLETED', 'POSTED', 'ACTIVE', 'EXECUTED', 'SIGNED', 'RENEWED', 'VARIED', 'DISPATCHED', 'DELIVERED', 'DONE', 'AUTHENTIC', 'RECEIVED', 'PASSED', 'PASS', 'RELEASED', 'RESOLVED', 'VERIFIED', 'OK', 'MATCHED', 'GREEN'].includes(s)) {
    return { kind: 'ok', tone: 'badge-green', icon: '✓', label };
  }
  if (['IN_PROGRESS', 'IN_REVIEW', 'REVIEW', 'PARTIALLY_DISPATCHED', 'PARTIAL', 'VALIDATING', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'].includes(s)) {
    return { kind: 'progress', tone: 'badge-progress', icon: '●', label };
  }
  if (['PENDING', 'SUBMITTED', 'PENDING_APPROVAL', 'HR_REVIEW', 'MANAGER_REVIEW', 'FINANCE_REVIEW', 'LEGAL_REVIEW', 'WAITING', 'OVERDUE', 'RETURNED', 'LOW', 'NOT_RECEIVED', 'NOT_INVOICED', 'AMBER', 'WARN'].includes(s)) {
    return { kind: 'pending', tone: 'badge-amber', icon: '⚠', label };
  }
  if (['REJECTED', 'TERMINATED', 'FAILED', 'FAIL', 'QUARANTINE', 'QUARANTINED', 'COMPROMISED', 'RECALLED', 'SPOILED', 'DAMAGED', 'LOST', 'DIFFERENCE', 'RED'].includes(s)) {
    return { kind: 'reject', tone: 'badge-red', icon: '✕', label };
  }
  if (['CRITICAL', 'LOCKED'].includes(s)) {
    return { kind: 'critical', tone: 'badge-critical', icon: '✕', label };
  }
  if (['SUSPENDED', 'ON_HOLD', 'MAINTENANCE', 'REWORK', 'SUSPICIOUS'].includes(s)) {
    return { kind: 'hold', tone: 'badge-hold', icon: '⚠', label };
  }
  if (['CANCELLED', 'CANCELED', 'VOID', 'VOIDED', 'DRAFT', 'CLOSED', 'ARCHIVED', 'EXPIRED', 'IDLE', 'OFFLINE', 'UNKNOWN'].includes(s)) {
    return { kind: 'draft', tone: 'badge-neutral', icon: '–', label };
  }
  if (['OPEN', 'NEW', 'REQUESTED', 'SCHEDULED', 'PLANNED', 'ALREADY_VERIFIED'].includes(s)) {
    return { kind: 'info', tone: 'badge-blue', icon: '●', label };
  }
  if (['SECRET', 'TOP_SECRET', 'CLASSIFIED', 'CONFIDENTIAL', 'RESTRICTED'].includes(s)) {
    return { kind: 'secure', tone: 'badge-purple', icon: '●', label };
  }
  return { kind: 'neutral', tone: 'badge-neutral', icon: '●', label };
}

export function statusTone(status: string | null | undefined): string {
  return statusMeta(status).tone;
}

export function Badge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="badge badge-neutral"><span className="badge-icon" aria-hidden>●</span>-</span>;
  }
  const meta = statusMeta(String(value));
  return (
    <span className={`badge ${meta.tone}`}>
      <span className="badge-icon" aria-hidden>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

export function Spinner() {
  return <div className="spinner" />;
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center-box" style={{ flexDirection: 'column', gap: 10 }}>
      <Spinner />
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</span>
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="error-banner">{msg}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice-banner">{children}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { maxWidth: 960 } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        Page {page} of {pages} · {total.toLocaleString()} records
      </span>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
    </div>
  );
}

/** Authenticated staff / passport photograph. Falls back to initials. */
export function StaffPhoto({
  path,
  hasPhoto,
  name,
  size = 72,
}: {
  path: string;
  hasPhoto?: boolean;
  name?: string;
  size?: number;
}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (hasPhoto === false) {
      setSrc('');
      return;
    }
    const token = getToken();
    let objectUrl = '';
    let cancelled = false;
    fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : undefined })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (cancelled || !b || b.size === 0) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc('');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, hasPhoto]);
  const h = Math.round(size * 1.28);
  if (!src) {
    const initial = String(name ?? '').trim().split(/\s+/).filter(Boolean)[0]?.[0] ?? '';
    return (
      <span className="staff-photo staff-photo-empty" style={{ width: size, height: h }} aria-hidden>
        {initial.toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="staff-photo"
      src={src}
      alt={name ? name + ' photograph' : 'Employee photograph'}
      style={{ width: size, height: h }}
    />
  );
}
