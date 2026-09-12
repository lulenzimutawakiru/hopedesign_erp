import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { useAuth, type MfaStatus } from '../auth';

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

function fmtWhen(value: string | null | undefined): string {
  if (!value) return 'Never';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Self-service security screen. The second factor is a 6-digit code mailed to the
 * user's personal address, so there is nothing to install and nothing to scan.
 */
export default function SecuritySettings() {
  const { user, setPersonalEmail, confirmPersonalEmail, disableMfa } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<MfaStatus>('/api/auth/mfa/status'));
      setError('');
    } catch (err) {
      setError(message(err, 'Unable to load your security settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendCode = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const r = await setPersonalEmail(email.trim());
      setMasked(r.maskedEmail);
      setCode('');
      setCodeSent(true);
      setNotice(
        r.alreadySent
          ? 'A code is already on its way to that address. Enter it below.'
          : 'Code sent. Open that inbox and enter the 6 digits below.'
      );
    } catch (err) {
      setError(message(err, 'Could not send the code'));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await confirmPersonalEmail(code.trim());
      setNotice('Personal email confirmed. Sign-in codes now go to that address.');
      setCodeSent(false);
      setCode('');
      setEmail('');
      setMasked('');
      await refresh();
    } catch (err) {
      setError(message(err, 'Could not confirm that code'));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await disableMfa();
      setConfirmOff(false);
      setNotice('Two-step verification is off. You will be asked to set it up again the next time you sign in.');
      await refresh();
    } catch (err) {
      setError(message(err, 'Could not turn off two-step verification'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) return <PageLoader label="Loading security settings" />;

  const enabled = Boolean(status?.mfaEnabled);
  const onFile = status?.personalEmail ?? null;
  const pending = status?.pendingEmail ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Security &amp; MFA</h1>
        <p className="muted">
          Your second factor is a 6-digit code mailed to your own personal address. No authenticator app, no QR
          code, and no shared phone needed.
        </p>
      </header>

      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="card">
        <div className="card-head">
          <h3>Two-step verification</h3>
          <Badge value={enabled ? 'ACTIVE' : 'DISABLED'} />
        </div>
        <div className="card-pad">
          <div className="kv-grid">
            <div className="kv">
              <span className="kv-k">Signing in as</span>
              <span className="kv-v">{user?.email || user?.username || '-'}</span>
            </div>
            <div className="kv">
              <span className="kv-k">Code destination</span>
              <span className="kv-v">{status?.maskedEmail || 'No personal email on file'}</span>
            </div>
            <div className="kv">
              <span className="kv-k">Address confirmed</span>
              <span className="kv-v">{fmtWhen(status?.verifiedAt)}</span>
            </div>
            {pending && (
              <div className="kv">
                <span className="kv-k">Awaiting confirmation</span>
                <span className="kv-v">{pending}</span>
              </div>
            )}
          </div>
          <p className="hint">
            Sign-in codes are single use and expire after 10 minutes. They are never written to logs and never
            stored in readable form.
          </p>
          {enabled ? (
            confirmOff ? (
              <div className="row-actions">
                <button className="btn" disabled={busy} onClick={() => setConfirmOff(false)}>
                  Keep it on
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void turnOff()}>
                  {busy ? 'Turning off' : 'Yes, turn it off'}
                </button>
              </div>
            ) : (
              <button className="btn" onClick={() => setConfirmOff(true)}>
                Turn off two-step verification
              </button>
            )
          ) : (
            <p className="hint">
              Two-step verification is currently off. Add a personal email below to switch it on.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>{onFile ? 'Change personal email' : 'Add personal email'}</h3>
        </div>
        <div className="card-pad">
          <p className="muted">
            Use an address only you can open. We mail a 6-digit code there to prove it is yours before it is used
            for sign-in.
          </p>
          <label className="field">
            <span>Personal email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@gmail.com"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {!codeSent ? (
            <button className="btn btn-primary" disabled={busy || !EMAIL_RE.test(email.trim())} onClick={() => void sendCode()}>
              {busy ? 'Sending' : 'Send code'}
            </button>
          ) : (
            <>
              <p className="muted">
                We emailed a 6-digit code to <strong>{masked || 'your new address'}</strong>. It expires in 10
                minutes.
              </p>
              <label className="field">
                <span>6-digit code</span>
                <input
                  className="login-otp"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={6}
                />
              </label>
              <div className="row-actions">
                <button className="btn" disabled={busy} onClick={() => void sendCode()}>
                  Resend code
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setCodeSent(false);
                    setCode('');
                    setNotice('');
                    setError('');
                  }}
                >
                  Use a different address
                </button>
                <button className="btn btn-primary" disabled={busy || code.trim().length < 6} onClick={() => void confirmCode()}>
                  {busy ? 'Confirming' : 'Confirm address'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}