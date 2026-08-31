import { FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { BrandMark } from '../components/BrandMark';
import { branchLabel, shortCompanyName, useCompanyProfile } from '../company';

export default function Login() {
  const { login } = useAuth();
  const company = useCompanyProfile();
  const branch = branchLabel(company);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(identifier.trim(), password);
      window.location.hash = '/dashboard';
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Unable to sign in';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div>
          <BrandMark size="lg" tone="hope" />
          <div className="eyebrow">{company.name}{branch ? ` · ${branch}` : ''}</div>
          <h2>The mill, the press, and the money in one operating system.</h2>
          <p>Paper manufacturing, security printing and QR custody — role-bound, dual-controlled, auditable.</p>
        </div>
        <div className="eyebrow">Clearance · RBAC · SoD · ABAC</div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <BrandMark size="lg" />
        <h1>{shortCompanyName(company.name)} OS</h1>
        <p className="muted">Sign in with your plant identity. Sessions are named, scoped and logged.</p>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span>Username or email</span>
          <input
            autoFocus
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="admin"
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !identifier || !password}>
          {busy ? 'Checking clearance…' : 'Enter the mill'}
        </button>
        <p className="hint">Forgot your password? Contact your system administrator.</p>
      </form>
    </div>
  );
}
