import { FormEvent, useState } from 'react';
import { api, setToken, ApiError } from '../api';
import { useHashQuery } from '../router';
import { BrandMark } from '../components/BrandMark';

export default function AcceptInvite() {
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
      const r = await api<{ accessToken: string }>('/api/auth/accept-invite', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setToken(r.accessToken);
      window.location.hash = '/dashboard';
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept invitation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div>
          <BrandMark size="lg" tone="hope" />
          <div className="eyebrow">Hope Design Group Ltd - Kampala</div>
          <h2>Welcome to Hope OS.</h2>
          <p>Set your password to activate your account and join the mill.</p>
        </div>
        <div className="eyebrow">Invitation - Secure token - Audited</div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <BrandMark size="lg" />
        <h1>Accept invitation</h1>
        <p className="muted">Choose a password for your Hope Design account.</p>
        {!token && <div className="alert alert-error">This invitation link is missing its token. Check the link you were sent.</div>}
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
          {busy ? 'Activating...' : 'Set password and activate'}
        </button>
      </form>
    </div>
  );
}
