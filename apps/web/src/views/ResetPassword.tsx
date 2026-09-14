import { FormEvent, useState } from 'react';
import { api, setToken, ApiError } from '../api';
import { useHashQuery } from '../router';
import { BrandMark } from '../components/BrandMark';
import { branchLabel, shortCompanyName, useCompanyProfile } from '../company';

/**
 * AUTH-003: the landing page for a self-service reset link. Public by design -
 * the holder cannot sign in, which is the whole reason they are here - and the
 * only credential it accepts is the single-use token from their inbox.
 */
export default function ResetPassword() {
  const company = useCompanyProfile();
  const branch = branchLabel(company);
  const q = useHashQuery();
  const token = q.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const r = await api<{ accessToken: string }>('/api/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setToken(r.accessToken);
      window.location.hash = '/dashboard';
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div>
          <BrandMark size="lg" logoUrl={company.logo_url} />
          <div className="eyebrow">{company.name}{branch ? ` · ${branch}` : ''}</div>
          <h2>Reset your {shortCompanyName(company.name)} password.</h2>
          <p>Choose a new password and we will sign you straight back in.</p>
        </div>
        <div className="eyebrow">Single-use link · Lockout cleared · Audited</div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <BrandMark size="lg" logoUrl={company.logo_url} />
        <h1>Choose a new password</h1>
        <p className="muted">This link works once. Setting a new password ends any other open sessions on your account.</p>
        {!token && (
          <div className="alert alert-error">
            This reset link is missing its token. Ask for a new one from the sign-in screen.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span>New password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !token || !password || !confirm}>
          {busy ? 'Saving…' : 'Set password and sign in'}
        </button>
        <p className="hint login-help">
          <a href="#/login">Back to sign in</a>
        </p>
      </form>
    </div>
  );
}
