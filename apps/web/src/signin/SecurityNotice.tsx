/**
 * The standing security notice carried by the sign-in surface.
 *
 * Credential phishing is the most common way into an ERP, and the countermeasure
 * that works is repetition: staff who have read "we will never ask you for your
 * code" a hundred times are the ones who hang up on the caller who does. The
 * notice therefore sits on every sign-in view rather than behind a link, but it
 * stays compact -- it is a warning, not the page.
 *
 * The wording makes only claims the platform actually honours: HOPE DESIGN has
 * no outbound channel that asks for credentials, and the official address is the
 * only address this application is served from.
 */

import { ShieldCheckIcon } from '../components/auth/icons';

export function SecurityNotice({ id = 'auth-security-notice' }: { id?: string }) {
  const titleId = `${id}-title`;
  return (
    <section className="auth-security" id={id} aria-labelledby={titleId}>
      <h2 className="auth-security-title" id={titleId}>
        <ShieldCheckIcon size={14} />
        <span>Security notice</span>
      </h2>
      <p className="auth-security-text">
        HOPE DESIGN will never ask you to disclose your password, verification code or
        authentication credentials through email, phone calls, pop-ups or chat.
      </p>
      <p className="auth-security-text">
        Always verify that you are using the official HOPE DESIGN ERP address before signing in.
      </p>
    </section>
  );
}
