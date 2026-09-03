import { FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { BrandMark } from '../components/BrandMark';
import { branchLabel, useCompanyProfile } from '../company';

export default function ChangePassword() {
  const { changePassword, logout, user } = useAuth();
  const company = useCompanyProfile();
  const branch = branchLabel(company);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      window.location.hash = '/dashboard';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unable to change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <aside className="login-hero">
        <img className="login-hero-photo" src="/login-mill.jpg" alt="Paper mill and security printing hall" />
        <div className="login-hero-veil" aria-hidden />
        <div className="login-hero-copy">
          <BrandMark size="lg" tone="hope" />
          <div className="eyebrow">{company.name}{branch ? ` · ${branch}` : ''}</div>
          <h2>Set a password only you hold.</h2>
          <p>Seeded and reset accounts must be rotated before the mill OS will open.</p>
        </div>
        <div className="login-hero-foot eyebrow">Clearance · RBAC · SoD · ABAC</div>
      </aside>
      <main className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <BrandMark size="lg" />
          <h1>Change password</h1>
          <p className="muted">
            {user?.first_name ? `${user.first_name}, your ` : 'Your '}
            account requires a new password before you can continue.
          </p>
          {error && <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="hint">At least 12 characters, with letters and numbers. Do not reuse the seeded default.</p>
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy || !currentPassword || newPassword.length < 12 || newPassword !== confirm}
          >
            {busy ? 'Saving…' : 'Save and continue'}
          </button>
          <button type="button" className="btn btn-block" onClick={logout} style={{ marginTop: 8 }}>
            Sign out
          </button>
        </form>
      </main>
    </div>
  );
}
