import { ReactNode, useEffect, useState } from 'react';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { CREATE_ITEMS } from '../work';

export { Skeleton } from './states';

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
  children,
  reasonLabel = 'Reason (written to the audit trail)',
  reasonRequired,
  confirmDisabled,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
  reasonLabel?: string | null;
  reasonRequired?: boolean;
  confirmDisabled?: boolean;
}) {
  const [reason, setReason] = useState('');
  const blocked = Boolean(confirmDisabled) || Boolean(reasonRequired && !reason.trim());
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-labelledby="confirm-title">
        <div className="modal-head"><h3 id="confirm-title">{title}</h3></div>
        <div className="modal-body">
          <p>{body}</p>
          {children}
          {reasonLabel !== null && (
            <div className="field">
              <label htmlFor="confirm-reason">{reasonLabel}</label>
              <input id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-required={reasonRequired || undefined} />
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Keep as-is</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={blocked} onClick={() => onConfirm(reason)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </div>
  );
}

export function CreateMenu() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const items = CREATE_ITEMS.filter((i) => can(user, i.perm));
  if (!items.length) return null;
  return (
    <div className="topbar-item">
      <button className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>+ Create</button>
      {open && (
        <div className="topbar-dropdown">
          <div className="dropdown-head">Start work</div>
          {items.map((i) => (
            <button key={i.id} className="search-item" onClick={() => { setOpen(false); navigate(i.href); }}>
              <span className="search-item-title">{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Meter({ label, value, max = 100 }: { label: string; value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : value));
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><strong>{Math.round(pct)}%</strong></div>
      <div className="meter-track" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} role="progressbar">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      {action && onAction && <button className="btn btn-primary" onClick={onAction}>{action}</button>}
    </div>
  );
}
