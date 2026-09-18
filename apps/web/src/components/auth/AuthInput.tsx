/**
 * Labelled text field for the sign-in surface.
 *
 * The label is always rendered (never a placeholder standing in for one), and
 * any hint or error is tied to the input through `aria-describedby` so screen
 * readers announce the guidance with the field rather than leaving the user to
 * hunt for it.
 */

import type { InputHTMLAttributes, ReactNode } from 'react';

export interface AuthInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  /** Visible, persistent field label. */
  label: string;
  /** Guidance shown under the field while it is valid. */
  hint?: string;
  /** Current field-level error. Replaces the hint and marks the field invalid. */
  error?: string;
  /**
   * Marks the field as refused without printing a message beneath it.
   *
   * Sign-in needs this: when a credential pair is rejected the user has to see
   * *which controls* were refused, but naming the offending field would reveal
   * whether the username or the password was the part that was wrong.
   */
  invalid?: boolean;
  /** Decorative glyph rendered inside the field, before the text. */
  icon?: ReactNode;
  /** Control rendered inside the field, after the text (e.g. a reveal toggle). */
  trailing?: ReactNode;
}

export function AuthInput({
  id,
  label,
  hint,
  error,
  invalid,
  icon,
  trailing,
  className,
  ...rest
}: AuthInputProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = errorId ?? hintId;
  const refused = Boolean(error) || Boolean(invalid);

  const inputClass = ['auth-input', icon ? 'has-icon' : '', trailing ? 'has-trailing' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`auth-field${refused ? ' is-invalid' : ''}`}>
      <label className="auth-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="auth-control">
        {icon ? (
          <span className="auth-control-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <input
          {...rest}
          id={id}
          className={inputClass}
          aria-invalid={refused ? true : undefined}
          aria-describedby={describedBy}
        />
        {trailing ? <span className="auth-control-trailing">{trailing}</span> : null}
      </div>
      {error ? (
        <p className="auth-field-error" id={errorId}>
          {error}
        </p>
      ) : hint ? (
        <p className="auth-field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
