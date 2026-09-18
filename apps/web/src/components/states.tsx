import { type ReactNode } from 'react';
import { can, useAuth } from '../auth';
import { navigate } from '../router';
import { Badge } from './ui';

export { Badge as StatusBadge };

export {
  Skeleton,
  Line,
  TableSkeleton,
  CardSkeleton,
  FormSkeleton,
  DashboardSkeleton,
} from './skeleton';

export function safeMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  if (!message || message.length > 180) return undefined;
  if (/select |insert |update |delete |pg_|syntax|stack|at \w+ \(/i.test(message)) return undefined;
  if (!/^[A-Z]/.test(message)) return undefined;
  return message;
}

/**
 * User-facing failure state. Technical detail stays server-side; the reference id
 * is the only handle a user is given so support can correlate the incident.
 */
export function ErrorState({
  title = 'Something went wrong',
  message = 'We could not load this view. The problem has been logged for the technical team.',
  referenceId,
  onRetry,
  showDashboard = true,
}: {
  title?: string;
  message?: string;
  referenceId?: string;
  onRetry?: () => void;
  showDashboard?: boolean;
}) {
  return (
    <div className="state-error" role="alert">
      <span className="state-error-mark" aria-hidden>!</span>
      <h3>{title}</h3>
      <p className="muted">{message}</p>
      <div className="quick-actions">
        {onRetry ? <button className="btn btn-primary" onClick={onRetry}>Try again</button> : null}
        {showDashboard ? (
          <button className="btn" onClick={() => navigate('/dashboard')}>Go to dashboard</button>
        ) : null}
      </div>
      {referenceId ? (
        <p className="state-ref">
          Reference <span className="cell-mono">{referenceId}</span>
        </p>
      ) : null}
    </div>
  );
}

export function PermissionGate({
  permission,
  allOf,
  fallback = null,
  children,
}: {
  permission?: string | string[];
  allOf?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const any = permission ? (Array.isArray(permission) ? permission : [permission]) : [];
  const anyOk = any.length === 0 || any.some((p) => can(user, p));
  const allOk = !allOf || allOf.every((p) => can(user, p));
  if (!anyOk || !allOk) return <>{fallback}</>;
  return <>{children}</>;
}

export function RoleGate({
  role,
  fallback = null,
  children,
}: {
  role: string | string[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const wanted = Array.isArray(role) ? role : [role];
  const codes = (user?.roles ?? []).map((r) => r.role_code);
  const ok = can(user, 'system.admin.all') || wanted.some((w) => codes.includes(w));
  if (!ok) return <>{fallback}</>;
  return <>{children}</>;
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div className="section-head-copy">
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * Brief 8. Comparison and trend render only when the caller supplies real figures;
 * an absent delta renders nothing rather than a fabricated percentage.
 */
export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  period,
  icon,
  href,
  tone,
  footer,
  loading,
}: {
  label: string;
  value: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  period?: string;
  icon?: ReactNode;
  href?: string;
  tone?: string;
  footer?: ReactNode;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="stat-card" aria-busy="true" aria-label={`Loading ${label}`}>
        <span className="skel skel-line" style={{ width: '45%' }} aria-hidden />
        <span className="skel skel-value" aria-hidden />
      </div>
    );
  }
  const inner = (
    <>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon ? <span className="stat-icon" aria-hidden>{icon}</span> : null}
      </div>
      <div className="stat-value">{value}</div>
      {delta !== undefined && delta !== null && Number.isFinite(delta) ? (
        <div className={'stat-delta ' + (delta >= 0 ? 'is-up' : 'is-down')}>
          <span aria-hidden>{delta >= 0 ? '\u2191' : '\u2193'}</span>
          <span>{Math.abs(delta).toFixed(1)}%</span>
          <span className="muted">{deltaLabel ?? period ?? ''}</span>
        </div>
      ) : period ? (
        <div className="stat-period muted">{period}</div>
      ) : null}
      {footer ? <div className="stat-foot muted">{footer}</div> : null}
      {href ? <span className="stat-go" aria-hidden>{'\u2192'}</span> : null}
    </>
  );
  if (href) {
    return (
      <button type="button" className="stat-card is-link" data-tone={tone} onClick={() => navigate(href)}>
        {inner}
      </button>
    );
  }
  return <div className="stat-card" data-tone={tone}>{inner}</div>;
}
