/**
 * Inline outcome messages for the sign-in surface.
 *
 * Authentication failures are announced rather than merely coloured: the error
 * element is an assertive live region, and the notice element is a polite one,
 * so a screen-reader user hears "the username or password is incorrect" without
 * having to go looking for what changed on screen.
 */

import { AlertIcon, CheckCircleIcon, InfoIcon } from './icons';

export type AuthAlertTone = 'error' | 'success' | 'info';

export function AuthAlert({
  tone,
  message,
  id,
}: {
  tone: AuthAlertTone;
  message: string;
  id?: string;
}) {
  if (!message) return null;
  const icon =
    tone === 'error' ? <AlertIcon size={17} /> : tone === 'success' ? <CheckCircleIcon size={17} /> : <InfoIcon size={17} />;

  return (
    <div
      className={`auth-alert auth-alert-${tone}`}
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="auth-alert-icon" aria-hidden>
        {icon}
      </span>
      <p className="auth-alert-text">{message}</p>
    </div>
  );
}

/** A sign-in failure the user must act on. */
export function AuthError({ message, id }: { message: string; id?: string }) {
  return <AuthAlert tone="error" message={message} id={id} />;
}

/** A successful step or a piece of guidance. */
export function AuthNotice({ message, id }: { message: string; id?: string }) {
  return <AuthAlert tone="success" message={message} id={id} />;
}
