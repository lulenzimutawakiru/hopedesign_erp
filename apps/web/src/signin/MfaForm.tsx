/**
 * Second-factor stage of the sign-in panel.
 *
 * Three shapes live here because the backend has three of them: an emailed code,
 * a TOTP challenge (kept for legacy enrollments), and the enrollment detours a
 * privileged account without a factor on file has to take before it can sign in.
 * They share the same skeleton so the panel never appears to change identity
 * mid-flow, and the page decides which one is showing.
 */

import { AuthButton } from '../components/auth/AuthButton';
import { AuthError, AuthNotice } from '../components/auth/AuthError';
import { AuthInput } from '../components/auth/AuthInput';
import { KeyIcon } from '../components/auth/icons';
import type { MfaMode } from './signin.types';

export interface MfaFormProps {
  mode: MfaMode;
  /** True while collecting an address to enroll, false once a code has been sent. */
  emailEntry: boolean;
  code: string;
  newEmail: string;
  qrDataUrl: string;
  secret: string;
  copied: boolean;
  busy: boolean;
  error: string;
  notice: string;
  maskedEmail: string;
  /** Seconds before the resend control unlocks. */
  resendIn: number;
  /** Label for the submit control, which differs per shape. */
  primaryLabel: string;
  /** True while the submit control has nothing usable to send. */
  submitDisabled: boolean;
  onCodeChange: (value: string) => void;
  onNewEmailChange: (value: string) => void;
  onCopySecret: () => void;
  onResend: () => void;
  onUseDifferentEmail: () => void;
  onBack: () => void;
}

export function MfaForm({
  mode,
  emailEntry,
  code,
  newEmail,
  qrDataUrl,
  secret,
  copied,
  busy,
  error,
  notice,
  maskedEmail,
  resendIn,
  primaryLabel,
  submitDisabled,
  onCodeChange,
  onNewEmailChange,
  onCopySecret,
  onResend,
  onUseDifferentEmail,
  onBack,
}: MfaFormProps) {
  const emailEntryStage = mode === 'email-enroll' && emailEntry;
  const codeFieldVisible = !emailEntryStage;

  return (
    <>
      {mode === 'totp-enroll' ? (
        <div className="auth-enroll">
          {qrDataUrl ? (
            <div className="login-qr">
              <img src={qrDataUrl} width={168} height={168} alt="Authenticator QR code" />
            </div>
          ) : null}
          <div className="login-setup-key">
            <code>{secret}</code>
            <AuthButton tone="secondary" icon={<KeyIcon size={15} />} onClick={onCopySecret}>
              {copied ? 'Copied' : 'Copy key'}
            </AuthButton>
          </div>
        </div>
      ) : null}

      <AuthNotice message={notice} id="signin-notice" />
      <AuthError message={error} id="signin-mfa-error" />

      {emailEntryStage && (
        <AuthInput
          id="signin-personal-email"
          label="Personal email"
          autoFocus
          type="email"
          name="personal-email"
          value={newEmail}
          onChange={(e) => onNewEmailChange(e.target.value)}
          placeholder="name@gmail.com"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={busy}
        />
      )}

      {codeFieldVisible && (
        <AuthInput
          id="signin-code"
          label="6-digit code"
          autoFocus
          className="login-otp"
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          maxLength={6}
          pattern="[0-9]*"
          enterKeyHint="go"
          disabled={busy}
        />
      )}

      <AuthButton type="submit" tone="primary" block busy={busy} busyLabel="Verifying..." disabled={submitDisabled}>
        {primaryLabel}
      </AuthButton>

      {codeFieldVisible && maskedEmail ? (
        <AuthButton block disabled={busy || resendIn > 0} onClick={onResend}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
        </AuthButton>
      ) : null}

      {mode !== 'totp-enroll' && !emailEntryStage ? (
        <AuthButton block disabled={busy} onClick={onUseDifferentEmail}>
          Use a different email address
        </AuthButton>
      ) : null}

      <AuthButton block disabled={busy} onClick={onBack}>
        Back to sign in
      </AuthButton>
    </>
  );
}

/** Copy shown under the panel title, which is the only per-shape prose the page cannot infer. */
export function mfaSubtitle(mode: MfaMode, emailEntry: boolean, maskedEmail: string): string {
  if (mode === 'totp-enroll') {
    return 'Scan this with Google Authenticator, Authy, or 1Password, then enter the 6-digit code.';
  }
  if (mode === 'email-enroll' && emailEntry) {
    return 'Add the personal email address your sign-in codes should go to. We will mail a 6-digit code there to confirm it.';
  }
  return `We emailed a 6-digit code to ${maskedEmail || 'your personal email address'}. It expires in 10 minutes.`;
}
