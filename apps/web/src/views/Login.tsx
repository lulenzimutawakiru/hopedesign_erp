import { FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { BrandMark } from '../components/BrandMark';
import { branchLabel, shortCompanyName, useCompanyProfile } from '../company';

type Stage = 'credentials' | 'mfa' | 'enroll';

function telHref(phone: string): string {
  return 'tel:' + phone.replace(/[^\d+]/g, '');
}

function mailtoHref(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function Login() {
  const { login, completeMfa, startEnrollment, completeEnrollment } = useAuth();
  const company = useCompanyProfile();
  const branch = branchLabel(company);
  const [stage, setStage] = useState<Stage>('credentials');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      if (stage === 'credentials') {
        const outcome = await login(identifier.trim(), password);
        if (outcome.status === 'ok') {
          window.location.hash = '/dashboard';
          return;
        }
        setStage(outcome.enrollmentRequired ? 'enroll' : 'mfa');
      } else if (stage === 'mfa') {
        await completeMfa(code.trim());
        window.location.hash = '/dashboard';
      } else {
        await completeEnrollment(code.trim(), secret || undefined);
        window.location.hash = '/dashboard';
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unable to sign in';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const beginEnrollment = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await startEnrollment();
      setSecret(r.secret);
      setOtpauthUrl(r.otpauthUrl);
      setStage('mfa');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start MFA setup');
    } finally {
      setBusy(false);
    }
  };

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
          <BrandMark size="lg" tone="hope" />
          <div className="eyebrow">{company.name}{branch ? ` · ${branch}` : ''}</div>
          <h2>The mill, the press, and the money in one operating system.</h2>
          <p>Paper manufacturing, security printing and QR custody — role-bound, dual-controlled, auditable.</p>
        </div>
        <div className="login-hero-foot eyebrow">Clearance · RBAC · SoD · ABAC</div>
      </aside>
      <main className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <BrandMark size="lg" />
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
        {stage === 'enroll' && (
          <>
            <p className="muted">Your role requires multi-factor authentication. Set up TOTP to continue.</p>
            {error && <div className="alert alert-error">{error}</div>}
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={beginEnrollment}
              disabled={busy}
            >
              {busy ? 'Preparing…' : 'Set up MFA'}
            </button>
            <button
              type="button"
              className="btn btn-block"
              onClick={() => { setStage('credentials'); setError(''); }}
            >
              Back
            </button>
          </>
        )}
        {stage === 'mfa' && (
          <>
            {secret ? (
              <>
                <p className="muted">
                  Scan or enter this code in your authenticator app, then enter the 6-digit code below.
                </p>
                <div className="alert" style={{ wordBreak: 'break-all' }}>
                  <strong>{secret}</strong>
                </div>
                {otpauthUrl && (
                  <p className="hint" style={{ wordBreak: 'break-all' }}>{otpauthUrl}</p>
                )}
              </>
            ) : (
              <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            )}
            {error && <div className="alert alert-error">{error}</div>}
            <label className="field">
              <span>6-digit code</span>
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.trim().length < 6}>
              {busy ? 'Verifying…' : secret ? 'Enable and continue' : 'Verify and continue'}
            </button>
            <button
              type="button"
              className="btn btn-block"
              onClick={() => { setStage('credentials'); setSecret(''); setCode(''); setError(''); }}
            >
              Back
            </button>
          </>
        )}
      </form>
      </main>
    </div>
  );
}