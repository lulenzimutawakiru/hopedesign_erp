import { useEffect, useState } from 'react';
import { useCompanyProfile } from '../company';

interface SignSession {
  tenantId?: number;
  companyId?: number;
  requestId?: number;
  signerId?: number;
  signerName?: string | null;
  signerEmail?: string | null;
  signerStatus?: string | null;
  requestStatus?: string | null;
  title?: string | null;
  message?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  storageKey?: string | null;
  signatureOrder?: string | null;
  expiresAt?: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const fmtDate = (v: unknown) => {
  if (!v) return '';
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? str(v) : d.toLocaleString('en-UG');
};

type Stage = 'loading' | 'error' | 'ready' | 'signed' | 'refused' | 'completed' | 'revoked';

export default function SignPortal({ token }: { token: string }) {
  const company = useCompanyProfile();
  const [session, setSession] = useState<SignSession | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const load = async () => {
    setStage('loading');
    setError('');
    try {
      const res = await fetch('/api/public/sign/' + encodeURIComponent(token));
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Could not load the signing page (${res.status})`);
      const data = (body?.data ?? null) as SignSession | null;
      if (!data) throw new Error('This signing link is invalid.');
      setSession(data);
      const s = str(data.signerStatus).toUpperCase();
      const r = str(data.requestStatus).toUpperCase();
      if (s === 'SIGNED') setStage('signed');
      else if (s === 'REFUSED') setStage('refused');
      else if (r === 'COMPLETED') setStage('completed');
      else if (r === 'REVOKED') setStage('revoked');
      else if (r === 'REFUSED') setStage('refused');
      else setStage('ready');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'This signing link is invalid.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submit = async () => {
    if (busy) return;
    if (!signature.trim()) {
      setError('Please type your full name to sign.');
      return;
    }
    if (!agree) {
      setError('Please confirm that you agree to sign electronically.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/public/sign/' + encodeURIComponent(token) + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature: signature.trim(),
          signatureData: { method: 'typed', name: signature.trim() },
          consent: { agreed: true, signedAt: new Date().toISOString(), method: 'typed' },
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Signing failed (${res.status})`);
      const result = body?.data ?? null;
      if (!result?.ok) {
        const reason = str(result?.reason);
        if (reason === 'AWAITING_PRIOR_SIGNER') {
          setError('Earlier signers must sign this document first.');
        } else if (reason === 'EXPIRED') {
          setStage('error');
          setError('This signing request has expired.');
        } else {
          setError('Signing failed: ' + (reason || 'unknown error'));
        }
        return;
      }
      setStage('signed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  const refuse = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/public/sign/' + encodeURIComponent(token) + '/refuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      const result = body?.data ?? null;
      if (!result?.ok) {
        setError('Could not decline: ' + str(result?.reason));
        return;
      }
      setStage('refused');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const isImage = /^image\//i.test(str(session?.mimeType));
  const isPdf = /pdf/i.test(str(session?.mimeType));
  const fileUrl = '/api/public/sign/' + encodeURIComponent(token) + '/file';

  return (
    <div className="page" style={{ maxWidth: 760, margin: '0 auto' }}>
      <header className="page-head">
        <div>
          <h1>Sign document</h1>
          <p className="muted">
            {company.name} e-signature portal. Review the document, then sign below.
          </p>
        </div>
      </header>

      {stage === 'loading' && <div className="card"><p className="muted">Loading document…</p></div>}

      {stage === 'error' && (
        <section className="card">
          <div className="result-hero warn">
            <div className="hero-icon" aria-hidden>!</div>
            <div>
              <h2>Signing link unavailable</h2>
              <p>{error || 'This signing link is invalid or has been revoked.'}</p>
            </div>
          </div>
        </section>
      )}

      {stage === 'signed' && (
        <section className="card">
          <div className="result-hero ok">
            <div className="hero-icon" aria-hidden>OK</div>
            <div>
              <h2>Signed</h2>
              <p>Thank you, {str(session?.signerName)}. Your signature has been recorded.</p>
            </div>
          </div>
        </section>
      )}

      {stage === 'refused' && (
        <section className="card">
          <div className="result-hero warn">
            <div className="hero-icon" aria-hidden>!</div>
            <div>
              <h2>Declined</h2>
              <p>You declined to sign this document. The requester has been notified.</p>
            </div>
          </div>
        </section>
      )}

      {stage === 'completed' && (
        <section className="card">
          <div className="result-hero ok">
            <div className="hero-icon" aria-hidden>OK</div>
            <div>
              <h2>Already completed</h2>
              <p>This document has already been fully signed by everyone.</p>
            </div>
          </div>
        </section>
      )}

      {stage === 'revoked' && (
        <section className="card">
          <div className="result-hero warn">
            <div className="hero-icon" aria-hidden>!</div>
            <div>
              <h2>Revoked</h2>
              <p>This signing request has been revoked by the requester.</p>
            </div>
          </div>
        </section>
      )}

      {stage === 'ready' && session && (
        <>
          <section className="card">
            <div className="card-head">
              <h3>{str(session.title)}</h3>
              {session.message && <p className="muted" style={{ margin: '4px 0 0' }}>{session.message}</p>}
            </div>
            <dl className="detail-list" style={{ marginTop: 8 }}>
              <div className="detail-row"><dt>Signing as</dt><dd>{str(session.signerName)}</dd></div>
              {session.signerEmail && <div className="detail-row"><dt>Email</dt><dd>{session.signerEmail}</dd></div>}
              {session.signatureOrder && <div className="detail-row"><dt>Signature order</dt><dd>{session.signatureOrder}</dd></div>}
              {session.expiresAt && <div className="detail-row"><dt>Expires</dt><dd>{fmtDate(session.expiresAt)}</dd></div>}
            </dl>
          </section>

          {session.storageKey && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <h3>Document</h3>
                <a className="btn btn-sm btn-ghost" href={fileUrl} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
              </div>
              <div style={{ marginTop: 10, minHeight: 200, border: '1px solid var(--border, #e2e8f0)', borderRadius: 8, overflow: 'hidden' }}>
                {isImage ? (
                  <img src={fileUrl} alt={str(session.fileName)} style={{ width: '100%', display: 'block' }} />
                ) : isPdf ? (
                  <iframe title="document" src={fileUrl} style={{ width: '100%', height: 480, border: 0 }} />
                ) : (
                  <div style={{ padding: 24, textAlign: 'center' }}>
                    <p className="muted">{str(session.fileName)}</p>
                    <a className="btn btn-primary" href={fileUrl} target="_blank" rel="noreferrer">Download document</a>
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="card" style={{ marginTop: 16 }}>
            <div className="card-head"><h3>Your signature</h3></div>
            <div className="stack" style={{ marginTop: 10 }}>
              <label className="field">
                <span>Full legal name</span>
                <input
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder="Type your full name"
                  autoComplete="off"
                />
              </label>
              <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span>I agree to sign this document electronically and confirm it is my intent to do so.</span>
              </label>
              {error && <div className="alert alert-error">{error}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" disabled={busy} onClick={submit}>
                  {busy ? 'Signing…' : 'Sign document'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setDeclineOpen((v) => !v)}
                  disabled={busy}
                >
                  Decline to sign
                </button>
              </div>
            </div>

            {declineOpen && (
              <div className="stack" style={{ marginTop: 12 }}>
                <label className="field">
                  <span>Reason (optional)</span>
                  <input
                    value={declineReason}
                    onChange={(e) => setDeclineReason(e.target.value)}
                    placeholder="Why are you declining?"
                  />
                </label>
                <button className="btn btn-danger" disabled={busy} onClick={refuse}>
                  {busy ? 'Sending…' : 'Confirm decline'}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
