import { useState } from 'react';

interface VerifyMember {
  reamNo?: string;
  code?: string;
  verified?: boolean;
  status?: string;
}

interface VerifyResult {
  result: string;
  verified: boolean;
  product?: string | null;
  code?: string;
  entity_type?: string;
  entityType?: string;
  verified_at?: string;
  verifiedAt?: string;
  ream?: Record<string, unknown> | null;
  carton?: (Record<string, unknown> & { members?: VerifyMember[] }) | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const fmtDate = (v: unknown) => {
  if (!v) return '';
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? str(v) : d.toLocaleString('en-UG');
};

export default function PublicVerify() {
  const [payload, setPayload] = useState('');
  const [data, setData] = useState<VerifyResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const verify = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const p = payload.trim();
    if (!p || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/public/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: p }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `Verification failed (${res.status})`);
      }
      setData(body?.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  const result = str(data?.result ?? '');
  const ok = result === 'AUTHENTIC' || result === 'VERIFIED';
  const ream = data?.ream;
  const carton = data?.carton;
  const members = Array.isArray(carton?.members) ? carton.members : [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Verify Authenticity</h1>
          <p className="muted">Public authenticity portal for Hope Design reams and cartons.</p>
        </div>
      </header>

      <section className="card">
        <form onSubmit={verify} className="stack">
          <label className="field">
            <span>QR payload or code</span>
            <input
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="HDG-RE-2026-00000001|secret  (scan the label QR or paste the payload)"
              autoComplete="off"
            />
          </label>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy || !payload.trim()}>
            {busy ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </section>

      {data && (
        <section className={`card ${ok ? 'scan-verified' : ''}`} style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Verification result</h3>
            <Badge value={result} />
          </div>
          {ok && (
            <div className="verify-mark" style={{ margin: '8px 0' }}>✔ QR VERIFIED</div>
          )}
          <dl className="detail-list">
            <div className="detail-row"><dt>Result</dt><dd><strong>{result}</strong></dd></div>
            {data.code && <div className="detail-row"><dt>Code</dt><dd className="cell-mono">{data.code}</dd></div>}
            {data.product && <div className="detail-row"><dt>Product</dt><dd>{data.product}</dd></div>}
            {str(data.entity_type ?? data.entityType) && (
              <div className="detail-row"><dt>Entity</dt><dd>{str(data.entity_type ?? data.entityType)}</dd></div>
            )}
            <div className="detail-row"><dt>Verified at</dt><dd>{fmtDate(data.verified_at ?? data.verifiedAt)}</dd></div>
          </dl>
          {ream && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-head"><h4>Ream</h4></div>
              <dl className="detail-list">
                <div className="detail-row"><dt>Ream no</dt><dd className="cell-mono">{str(ream.ream_no ?? ream.reamNo)}</dd></div>
                <div className="detail-row"><dt>Sheets</dt><dd>{str(ream.sheets ?? '')}</dd></div>
                <div className="detail-row"><dt>GSM</dt><dd>{str(ream.gsm ?? '')}</dd></div>
                <div className="detail-row"><dt>Status</dt><dd>{str(ream.status ?? '')}</dd></div>
                {str(ream.carton_no ?? ream.cartonNo) && (
                  <div className="detail-row"><dt>Carton</dt><dd className="cell-mono">{str(ream.carton_no ?? ream.cartonNo)}</dd></div>
                )}
              </dl>
            </div>
          )}
          {carton && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-head"><h4>Carton</h4></div>
              <dl className="detail-list">
                <div className="detail-row"><dt>Carton no</dt><dd className="cell-mono">{str(carton.carton_no ?? carton.cartonNo)}</dd></div>
                <div className="detail-row"><dt>Ream count</dt><dd>{str(carton.ream_count ?? carton.reamCount ?? members.length)}</dd></div>
                <div className="detail-row"><dt>Status</dt><dd>{str(carton.status ?? '')}</dd></div>
              </dl>
              {members.length > 0 && (
                <>
                  <h4 style={{ margin: '12px 0 8px' }}>Reams in this carton</h4>
                  <table className="table">
                    <thead>
                      <tr><th>#</th><th>Ream</th><th>QR code</th><th>Verified</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {members.map((m, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td className="cell-mono">{str(m.reamNo ?? m.ream_no)}</td>
                          <td className="cell-mono">{str(m.code)}</td>
                          <td>{m.verified ? 'Yes' : 'No'}</td>
                          <td>{str(m.status ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        Tip: the same QR can also be scanned at <code>/verify</code>. Each unique ream carries its own
        unforgeable payload; a carton QR links the 5 reams packed inside it.
      </p>
    </div>
  );
}

function Badge({ value }: { value: string }) {
  const v = String(value ?? '').toUpperCase();
  const tone =
    v === 'AUTHENTIC' || v === 'VERIFIED'
      ? 'badge-teal'
      : v === 'ALREADY_VERIFIED' || v === 'SUSPICIOUS'
        ? 'badge-warn'
        : v === 'UNKNOWN' || v === 'COMPROMISED' || v === 'VOID'
          ? 'badge-danger'
          : 'badge-info';
  return <span className={`badge ${tone}`}><span className="badge-icon" aria-hidden>●</span>{String(value ?? '')}</span>;
}