import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { BrandMark } from '../components/BrandMark';
import { branchLabel, shortCompanyName, useCompanyProfile } from '../company';

type Stage = 'credentials' | 'mfa';
/** How the second factor is being satisfied. Email is the default; TOTP stays for legacy enrollments. */
type MfaMode = 'code' | 'email-enroll' | 'totp-enroll';

function telHref(phone: string): string {
  return 'tel:' + phone.replace(/[^\d+]/g, '');
}

function mailtoHref(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function Login() {
  const {
    login,
    completeMfa,
    startEnrollment,
    completeEnrollment,
    startEmailCode,
    resendEmailCode,
    completeEmailEnroll,
  } = useAuth();
  const company = useCompanyProfile();
  const branch = branchLabel(company);
  const [stage, setStage] = useState<Stage>('credentials');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [mfaMode, setMfaMode] = useState<MfaMode>('code');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailEntry, setEmailEntry] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const osName = `${shortCompanyName(company.name)} OS`;
  const adminEmail = (company.email || company.branch_email).trim();
  const adminPhone = (company.phone || company.branch_phone).trim();
  const resetMail = adminEmail
    ? mailtoHref(
        adminEmail,
        `Password reset — ${osName}`,
        `Please reset the plant login for:\n\nUsername or email: ${identifier.trim() || '(not provided)'}\n\nI cannot sign in to ${osName}.`
      )
    : '';
  const contactMail = adminEmail
    ? mailtoHref(
        adminEmail,
        `Sign-in help — ${osName}`,
        `I need help signing in to ${osName}.\n\nUsername or email: ${identifier.trim() || '(not provided)'}`
      )
    : '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (stage === 'credentials') {
        const outcome = await login(identifier.trim(), password);
        if (outcome.status === 'ok') {
          window.location.hash = '/dashboard';
          return;
        }
        setStage('mfa');
        if (outcome.method === 'totp') {
          setMfaMode('code');
          setMaskedEmail('');
          setResendIn(0);
          if (outcome.enrollmentRequired) {
            const r = await startEnrollment();
            setSecret(r.secret);
            setQrDataUrl(r.qrDataUrl ?? '');
            setMfaMode('totp-enroll');
          }
          return;
        }
        // Email factor. A privileged account with no address on file enrolls one
        // here rather than being stranded at the sign-in screen.
        if (outcome.enrollmentRequired) {
          setMfaMode('email-enroll');
          setMaskedEmail('');
          setEmailEntry(true);
          setResendIn(0);
        } else {
          setMfaMode('code');
          setMaskedEmail(outcome.maskedEmail ?? '');
          setResendIn(outcome.resendAfterSeconds ?? 0);
        }
        return;
      }

      if (mfaMode === 'email-enroll') {
        if (!codeSent) {
          const r = await startEmailCode(newEmail.trim());
          setMaskedEmail(r.maskedEmail);
          setResendIn(r.resendAfterSeconds ?? 0);
          setCodeSent(true);
          setEmailEntry(false);
          setNotice(r.alreadySent ? 'That code is still valid — enter it below.' : 'Code sent. Check your inbox.');
          return;
        }
        await completeEmailEnroll(code.trim());
      } else if (mfaMode === 'totp-enroll') {
        await completeEnrollment(code.trim(), secret);
      } else {
        await completeMfa(code.trim());
      }
      window.location.hash = '/dashboard';
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unable to sign in';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const resend = async (email?: string) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const r = email ? await startEmailCode(email) : await resendEmailCode();
      setMaskedEmail(r.maskedEmail);
      setResendIn(r.resendAfterSeconds ?? 0);
      setCodeSent(true);
      setEmailEntry(false);
      setNotice(r.alreadySent ? 'A code is already on its way — check your inbox.' : 'Re-sent. Check your inbox.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not send the code';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const resetMfa = () => {
    setStage('credentials');
    setSecret('');
    setQrDataUrl('');
    setCode('');
    setError('');
    setNotice('');
    setMfaMode('code');
    setMaskedEmail('');
    setNewEmail('');
    setEmailEntry(false);
    setCodeSent(false);
    setResendIn(0);
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const onCodeChange = (raw: string) => {
    setCode(raw.replace(/\D/g, '').slice(0, 6));
  };

  const emailEntryStage = mfaMode === 'email-enroll' && emailEntry;
  const codeFieldVisible = !emailEntryStage;
  const primaryLabel = emailEntryStage
    ? 'Send code'
    : mfaMode === 'totp-enroll'
      ? 'Confirm and continue'
      : 'Continue';
  const submitDisabled = emailEntryStage ? !newEmail.trim() : code.trim().length < 6;

  return (
    <div className="login-page">
      <aside className="login-hero">
        <img
          className="login-hero-photo"
          src="/login-mill.jpg"
          alt="Paper mill and security printing hall"
        />
        <div className="login-hero-veil" aria-hidden />
        <div className="login-hero-copy">
          <BrandMark size="lg" tone="hope" logoUrl={company.logo_url} />
          <div className="eyebrow">{company.name}{branch ? ` · ${branch}` : ''}</div>
          <h2>The mill, the press, and the money in one operating system.</h2>
          <p>Paper manufacturing, security printing and QR custody — role-bound, dual-controlled, auditable.</p>
        </div>
        <div className="login-hero-foot eyebrow">Clearance · RBAC · SoD · ABAC</div>
      </aside>
      <main className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <BrandMark size="lg" logoUrl={company.logo_url} />
        <h1>{shortCompanyName(company.name)} OS</h1>
        {stage === 'credentials' && (
          <>
            <p className="muted">Sign in with your plant identity. Sessions are named, scoped and logged.</p>
            {error && <div className="alert alert-error">{error}</div>}
            <label className="field">
              <span>Username or email</span>
              <input
                autoFocus
                name="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                enterKeyHint="go"
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !identifier || !password}>
              {busy ? 'Checking clearance…' : 'Enter the mill'}
            </button>
            <div className="login-help-block">
              <p className="hint login-help">
                {resetMail ? (
                  <a href={resetMail}>Forgot your password?</a>
                ) : (
                  <span>Forgot your password?</span>
                )}{' '}
                {contactMail ? (
                  <a href={contactMail}>Contact your system administrator.</a>
                ) : (
                  <span>Contact your system administrator.</span>
                )}
              </p>
              {(adminEmail || adminPhone) && (
                <p className="hint login-help-contacts">
                  {adminEmail ? <a href={contactMail || `mailto:${adminEmail}`}>{adminEmail}</a> : null}
                  {adminEmail && adminPhone ? <span className="login-help-sep" aria-hidden> · </span> : null}
                  {adminPhone ? <a href={telHref(adminPhone)}>{adminPhone}</a> : null}
                </p>
              )}
            </div>
          </>
        )}
        {stage === 'mfa' && (
          <>
            {mfaMode === 'totp-enroll' ? (
              <>
                <p className="muted">Scan this with Google Authenticator, Authy, or 1Password, then enter the 6-digit code.</p>
                {qrDataUrl ? (
                  <div className="login-qr">
                    <img src={qrDataUrl} width={168} height={168} alt="Authenticator QR code" />
                  </div>
                ) : null}
                <div className="login-setup-key">
                  <code>{secret}</code>
                  <button type="button" className="btn btn-sm" onClick={() => void copySecret()}>
                    {copied ? 'Copied' : 'Copy key'}
                  </button>
                </div>
              </>
            ) : emailEntryStage ? (
              <p className="muted">
                Add the personal email address your sign-in codes should go to. We will mail a 6-digit code there to confirm it.
              </p>
            ) : (
              <p className="muted">
                We emailed a 6-digit code to <strong>{maskedEmail || 'your personal email address'}</strong>. It expires in 10 minutes.
              </p>
            )}
            {notice && <div className="alert alert-success">{notice}</div>}
            {error && <div className="alert alert-error">{error}</div>}
            {emailEntryStage && (
              <label className="field">
                <span>Personal email</span>
                <input
                  autoFocus
                  type="email"
                  name="personal-email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="name@gmail.com"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                />
              </label>
            )}
            {codeFieldVisible && (
              <label className="field">
                <span>6-digit code</span>
                <input
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
                />
              </label>
            )}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || submitDisabled}>
              {busy ? 'Verifying\u2026' : primaryLabel}
            </button>
            {codeFieldVisible && maskedEmail ? (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy || resendIn > 0}
                onClick={() => void resend(mfaMode === 'email-enroll' ? newEmail.trim() : undefined)}
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            ) : null}
            {mfaMode !== 'totp-enroll' && !emailEntryStage ? (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => {
                  setMfaMode('email-enroll');
                  setEmailEntry(true);
                  setCodeSent(false);
                  setCode('');
                  setError('');
                  setNotice('');
                }}
              >
                Use a different email address
              </button>
            ) : null}
            <button type="button" className="btn btn-block" onClick={resetMfa}>
              Back
            </button>
          </>
        )}
      </form>
      </main>
    </div>
  );
}
