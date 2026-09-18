/**
 * HOPE DESIGN ERP sign-in gateway.
 *
 * Composition follows the enterprise teller pattern the brief asked for -- a
 * full-bleed industrial visual with the authentication surface sitting over it
 * as an independent, quiet panel -- built entirely from HOPE DESIGN's own
 * identity. Nothing here is a bank clone: the visual is the plant's own press
 * hall, the structure is the navy/sky palette the rest of the ERP already uses,
 * and the red accent is reserved for refusal states rather than decoration.
 *
 * This file owns the flow and nothing else. It holds the auth session state, the
 * requests and the outcome copy; `LoginForm` and `MfaForm` own layout. Every
 * endpoint, redirect, notification string and stage transition below is the same
 * behaviour that shipped before the redesign -- the changes are the error copy
 * funnel, the button labels, and the refusal marking on the credential pair.
 */

import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError, api } from '../api';
import { BrandMark } from '../components/BrandMark';
import { BrandGlyph, GlobeIcon, HelpIcon, ShieldCheckIcon } from '../components/auth/icons';
import { branchLabel, shortCompanyName, useCompanyProfile } from '../company';
import { LoginForm } from './LoginForm';
import { MfaForm, mfaSubtitle } from './MfaForm';
import { SecurityNotice } from './SecurityNotice';
import { describeAuthError } from './errorCopy';
import type { MfaMode, Stage } from './signin.types';

function telHref(phone: string): string {
  return 'tel:' + phone.replace(/[^\d+]/g, '');
}

function mailtoHref(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Turn a configured verification path into a hash route, whichever form it was stored in. */
function hashRoute(url: string): string {
  if (!url) return '#/verify';
  if (url.startsWith('#/')) return url;
  return url.startsWith('/') ? `#${url}` : `#/${url}`;
}

export function LoginPage() {
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
  /**
   * Set when the backend refuses a credential pair. It marks both controls so
   * the user can see the submission was rejected, without printing a message
   * under either one -- naming the guilty field would tell an attacker whether
   * the username or the password was the part that was wrong.
   */
  const [refused, setRefused] = useState(false);
  // Self-service reset lives inline on the sign-in card: the employee is already
  // on the right screen, and the request also raises a Service Desk ticket so
  // the desk sees recoverable access trouble without being told.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNotice, setResetNotice] = useState('');
  const [resetError, setResetError] = useState('');

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const osName = `${shortCompanyName(company.name)} OS`;
  const adminEmail = (company.email || company.branch_email).trim();
  const adminPhone = (company.phone || company.branch_phone).trim();
  const adminPhoneHref = adminPhone ? telHref(adminPhone) : '';
  const configuredName = company.legal_name || company.name;
  const legalName = configuredName && configuredName !== 'Company' ? configuredName : 'HOPE DESIGN GROUP LTD';
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
  // Only claimed when it is true: the development stack is served over plain
  // HTTP, and a padlock that lies is worse than no padlock at all.
  const secureTransport = typeof window !== 'undefined' && window.location.protocol === 'https:';

  const requestReset = async () => {
    const id = identifier.trim();
    if (!id) {
      setResetError('Enter your username or email address above first.');
      return;
    }
    setResetBusy(true);
    setResetError('');
    setResetNotice('');
    try {
      const r = await api<{ ok: boolean; message?: string }>('/api/auth/password/forgot', {
        method: 'POST',
        body: JSON.stringify({ identifier: id }),
      });
      setResetNotice(r.message ?? 'If that account exists, we have emailed a reset link.');
    } catch (err) {
      setResetError(describeAuthError(err, 'reset', 'Could not start the reset. Please try again.'));
    } finally {
      setResetBusy(false);
    }
  };

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
        setRefused(false);
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
          setNotice(
            'Your account needs a two-step verification address before it can sign in. Add one below and we will mail a code.'
          );
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
      if (
        stage === 'credentials' &&
        err instanceof ApiError &&
        (err.status === 400 || err.status === 401 || err.status === 423)
      ) {
        setRefused(true);
      }
      setError(describeAuthError(err, stage === 'credentials' ? 'signin' : 'mfa', 'Unable to sign in'));
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
      setError(describeAuthError(err, 'send-code', 'Could not send the code'));
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
    setRefused(false);
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
  const primaryLabel = emailEntryStage ? 'Send code' : mfaMode === 'totp-enroll' ? 'Confirm and continue' : 'Continue';
  const submitDisabled = emailEntryStage ? !newEmail.trim() : code.trim().length < 6;
  const subtitle =
    stage === 'credentials'
      ? 'Sign in with your plant identity. Sessions are named, scoped and logged.'
      : mfaSubtitle(mfaMode, emailEntry, maskedEmail);

  return (
    <div className="auth-shell">
      <header className="auth-topbar">
        <div className="auth-brand">
          <BrandGlyph size={26} title="HOPE DESIGN" />
          <span className="auth-brand-name">HOPE DESIGN</span>
          <span className="auth-brand-sep" aria-hidden />
          <span className="auth-brand-product">ERP</span>
        </div>

        <div className="auth-topbar-actions">
          {secureTransport ? (
            <span className="auth-secure-chip">
              <ShieldCheckIcon size={14} />
              <span>Secure connection</span>
            </span>
          ) : null}
          <span className="auth-lang" title="English is the only language configured for this deployment">
            <GlobeIcon size={15} />
            <span>English</span>
          </span>
          {contactMail ? (
            <a className="auth-topbar-link" href={contactMail}>
              <HelpIcon size={15} />
              <span>Help</span>
            </a>
          ) : null}
        </div>
      </header>

      <div className="login-page">
        <aside className="login-hero">
          <img className="login-hero-photo" src="/login-mill.jpg" alt="Paper mill and security printing hall" />
          <div className="login-hero-veil" aria-hidden />
          <div className="login-hero-copy">
            <BrandMark size="lg" logoUrl={company.logo_url} />
            <div className="eyebrow">
              {company.name}
              {branch ? ` · ${branch}` : ''}
            </div>
            <h2>The mill, the press, and the money in one operating system.</h2>
            <p>Paper manufacturing, security printing and QR custody — role-bound, dual-controlled, auditable.</p>
          </div>
          <div className="login-hero-foot eyebrow">Clearance · RBAC · SoD · ABAC</div>
        </aside>

        <main className="login-panel">
          <form className="login-card" onSubmit={submit}>
            <div className="auth-panel-head">
              <BrandMark size="lg" logoUrl={company.logo_url} />
              <p className="auth-kicker">
                {stage === 'credentials' ? 'Secure enterprise access' : 'Two-step verification'}
              </p>
              <h1>{osName}</h1>
              {stage === 'mfa' ? <h2 className="auth-stage-title">Verify your identity</h2> : null}
              <p className="muted">{subtitle}</p>
            </div>

            {stage === 'credentials' ? (
              <LoginForm
                identifier={identifier}
                password={password}
                busy={busy}
                error={error}
                refused={refused}
                onIdentifierChange={(v) => {
                  setIdentifier(v);
                  setRefused(false);
                }}
                onPasswordChange={(v) => {
                  setPassword(v);
                  setRefused(false);
                }}
                reset={{
                  open: resetOpen,
                  identifier,
                  busy: resetBusy,
                  notice: resetNotice,
                  error: resetError,
                  resetMail,
                  contactMail,
                  adminEmail,
                  adminPhoneHref,
                  onOpen: () => {
                    setResetOpen(true);
                    setResetError('');
                    setResetNotice('');
                  },
                  onCancel: () => setResetOpen(false),
                  onRequest: () => void requestReset(),
                }}
              />
            ) : (
              <MfaForm
                mode={mfaMode}
                emailEntry={emailEntry}
                code={code}
                newEmail={newEmail}
                qrDataUrl={qrDataUrl}
                secret={secret}
                copied={copied}
                busy={busy}
                error={error}
                notice={notice}
                maskedEmail={maskedEmail}
                resendIn={resendIn}
                primaryLabel={primaryLabel}
                submitDisabled={submitDisabled}
                onCodeChange={onCodeChange}
                onNewEmailChange={setNewEmail}
                onCopySecret={() => void copySecret()}
                onResend={() => void resend(mfaMode === 'email-enroll' ? newEmail.trim() : undefined)}
                onUseDifferentEmail={() => {
                  setMfaMode('email-enroll');
                  setEmailEntry(true);
                  setCodeSent(false);
                  setCode('');
                  setError('');
                  setNotice('');
                }}
                onBack={resetMfa}
              />
            )}

            <SecurityNotice />
          </form>
        </main>
      </div>

      <footer className="auth-footer">
        <span className="auth-footer-copy">
          © {new Date().getFullYear()} {legalName}
        </span>
        <nav className="auth-footer-links" aria-label="Verification and support">
          <a href={hashRoute(company.verify_url)}>Verify authenticity</a>
          {adminEmail ? <a href={contactMail || `mailto:${adminEmail}`}>Support</a> : null}
          {adminPhoneHref ? <a href={adminPhoneHref}>{adminPhone}</a> : null}
        </nav>
      </footer>
    </div>
  );
}

export default LoginPage;
