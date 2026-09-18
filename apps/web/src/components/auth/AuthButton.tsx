/**
 * Button primitive for the sign-in surface.
 *
 * Three things the plain `.btn` does not do and authentication needs: it reports
 * `aria-busy` while a request is in flight, it disables itself for the duration
 * so a second Enter cannot fire a duplicate submission, and it can swap its own
 * label for a progress label without the caller re-implementing the swap.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Request in flight: shows the spinner, sets `aria-busy`, blocks re-entry. */
  busy?: boolean;
  /** Label shown while `busy`. Falls back to the children. */
  busyLabel?: string;
  tone?: 'primary' | 'secondary';
  /** Full-width, for the primary action in a narrow panel. */
  block?: boolean;
  /** Decorative glyph rendered before the label. */
  icon?: ReactNode;
}

export function AuthButton({
  busy = false,
  busyLabel,
  tone = 'primary',
  block = false,
  icon,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: AuthButtonProps) {
  const classes = ['auth-btn', `auth-btn-${tone}`, block ? 'auth-btn-block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner auth-btn-spinner" aria-hidden /> : icon ? <span className="auth-btn-icon" aria-hidden>{icon}</span> : null}
      <span>{busy && busyLabel ? busyLabel : children}</span>
    </button>
  );
}
