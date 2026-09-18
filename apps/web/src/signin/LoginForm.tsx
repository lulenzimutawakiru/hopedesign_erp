/**
 * Credential stage of the sign-in panel.
 *
 * Presentational only. The page owns the session, the request and the outcome
 * copy; this file owns the arrangement of the two credential controls and the
 * recovery affordance that sits beneath them, so the sign-in flow can be read
 * without also reading the layout.
 */

import { AuthButton } from '../components/auth/AuthButton';
import { AuthError, AuthNotice } from '../components/auth/AuthError';
import { AuthInput } from '../components/auth/AuthInput';
import { PasswordInput } from '../components/auth/PasswordInput';
import { UserIcon } from '../components/auth/icons';

/** Everything the inline reset panel needs, including the support destinations. */
export interface ResetPanelProps {
  open: boolean;
  identifier: string;
  busy: boolean;
  notice: string;
  error: string;
  /** Pre-filled `mailto:` for asking IT directly. Empty when the organisation has no address on file. */
  resetMail: string;
  /** Pre-filled `mailto:` for a sign-in question. Empty when the organisation has no address on file. */
  contactMail: string;
  adminEmail: string;
  /** `tel:` for the support line. Empty when the organisation has no number on file. */
  adminPhoneHref: string;
  onOpen: () => void;
  onCancel: () => void;
  onRequest: () => void;
}

export interface LoginFormProps {
  identifier: string;
  password: string;
  busy: boolean;
  error: string;
  /**
   * Set when the backend refuses a credential pair. Both controls are marked
   * refused without a message under either of them: naming the offending field
   * would tell an attacker whether the username or the password was the part
   * that was wrong.
   */
  refused: boolean;
  onIdentifierChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  reset: ResetPanelProps;
}

export function LoginForm({
  identifier,
  password,
  busy,
  error,
  refused,
  onIdentifierChange,
  onPasswordChange,
  reset,
}: LoginFormProps) {
  return (
    <>
      <AuthError message={error} id="signin-error" />

      <AuthInput
        id="signin-identifier"
        label="Username or work email"
        icon={<UserIcon size={16} />}
        autoFocus
        name="username"
        value={identifier}
        onChange={(e) => onIdentifierChange(e.target.value)}
        placeholder="admin"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        invalid={refused}
        disabled={busy}
      />

      <PasswordInput
        id="signin-password"
        label="Password"
        name="password"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        autoComplete="current-password"
        enterKeyHint="go"
        invalid={refused}
        disabled={busy}
      />

      <AuthButton
        type="submit"
        tone="primary"
        block
        busy={busy}
        busyLabel="Signing in..."
        disabled={!identifier || !password}
      >
        Sign in
      </AuthButton>

      <ResetPanel {...reset} />
    </>
  );
}

function ResetPanel({
  open,
  identifier,
  busy,
  notice,
  error,
  resetMail,
  contactMail,
  adminEmail,
  adminPhoneHref,
  onOpen,
  onCancel,
  onRequest,
}: ResetPanelProps) {
  const hasSupportLine = Boolean(adminEmail || adminPhoneHref);
  const entered = identifier.trim();

  return (
    <div className="login-help-block">
      {!open ? (
        <p className="hint login-help">
          <button type="button" className="link-btn" onClick={onOpen}>
            Forgot your password?
          </button>{' '}
          {contactMail ? (
            <a href={contactMail}>Contact your system administrator.</a>
          ) : (
            <span>Contact your system administrator.</span>
          )}
        </p>
      ) : (
        <div className="login-reset">
          <p className="hint login-help">
            {entered ? (
              <>
                We will email a single-use reset link for <strong>{entered}</strong>.
              </>
            ) : (
              <span>Enter your username or email above, then ask for a reset link.</span>
            )}
          </p>
          <p className="hint">A support ticket is logged with IT automatically.</p>
          <AuthNotice message={notice} id="signin-reset-notice" />
          <AuthError message={error} id="signin-reset-error" />
          <AuthButton
            tone="secondary"
            block
            busy={busy}
            busyLabel="Sending..."
            disabled={!entered}
            onClick={onRequest}
          >
            Email me a reset link
          </AuthButton>
          {resetMail ? (
            <p className="hint login-help">
              <a href={resetMail}>Or email IT directly.</a>
            </p>
          ) : null}
          <button type="button" className="link-btn login-reset-cancel" onClick={onCancel}>
            Back to sign in
          </button>
        </div>
      )}

      {hasSupportLine && (
        <p className="hint login-help-contacts">
          {adminEmail ? <a href={contactMail || `mailto:${adminEmail}`}>{adminEmail}</a> : null}
          {adminEmail && adminPhoneHref ? (
            <span className="login-help-sep" aria-hidden>
              {' · '}
            </span>
          ) : null}
          {adminPhoneHref ? <a href={adminPhoneHref}>{adminPhoneHref.replace(/^tel:/, '')}</a> : null}
        </p>
      )}
    </div>
  );
}
