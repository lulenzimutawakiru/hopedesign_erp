import { useEffect, useState } from 'react';
import { useCompanyProfile } from '../company';

interface VerifyMember {
  reamNo?: string;
  ream_no?: string;
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
  productCode?: string | null;
  product_code?: string | null;
  batchNo?: string | null;
  batch_no?: string | null;
  ream?: Record<string, unknown> | null;
  carton?: (Record<string, unknown> & { members?: VerifyMember[] }) | null;
}

interface CompanyInfo {
  name?: string | null;
  tagline?: string | null;
  legal_name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  brand_color?: string | null;
  brand_color_secondary?: string | null;
  logo_url?: string | null;
  verify_url?: string | null;
}

interface DocVerifyResult {
  valid: boolean;
  tampered: boolean;
  reason?: string;
  fingerprint?: string | null;
  code?: string | null;
  title?: string | null;
  issuedAt?: string | null;
  issuer?: string | null;
  companyName?: string | null;
  company?: CompanyInfo | null;
}

interface ContractVerifyResult {
  valid: boolean;
  status?: string;
  document_no?: string | null;
  document_type?: string | null;
  first_verified_at?: string | null;
  verify_count?: number;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const fmtDate = (v: unknown) => {
  if (!v) return '';
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? str(v) : d.toLocaleString('en-UG');
};

const copyText = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

export default function PublicVerify() {
  const company = useCompanyProfile();
  const [payload, setPayload] = useState('');
  const [data, setData] = useState<VerifyResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [docToken, setDocToken] = useState('');
  const [docResult, setDocResult] = useState<DocVerifyResult | null>(null);
  const [docError, setDocError] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const [contrCode, setContrCode] = useState('');
  const [contrSecret, setContrSecret] = useState('');
  const [contrResult, setContrResult] = useState<ContractVerifyResult | null>(null);
  const [contrError, setContrError] = useState('');
  const [contrBusy, setContrBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    setDocResult(null);
    setDocError('');
    const m = hash.match(/^#doc=(.+)$/);
    if (!m) {
      setDocToken('');
      return;
    }
    const token = decodeURIComponent(m[1]);
    setDocToken(token);
    let cancelled = false;
    (async () => {
      setDocBusy(true);
      try {
        const res = await fetch('/api/public/verify-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error?.message ?? `Verification failed (${res.status})`);
        }
        if (!cancelled) setDocResult(body?.data ?? null);
      } catch (err) {
        if (!cancelled) setDocError(err instanceof Error ? err.message : 'Verification failed');
      } finally {
        if (!cancelled) setDocBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [window.location.hash]);

  const verify = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const p = payload.trim();
    if (!p || busy) return;
    setBusy(true);
    setError('');
    setDocResult(null);
    setDocError('');
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

  const verifyContract = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const code = contrCode.trim();
    const secret = contrSecret.trim();
    if (!code || !secret || contrBusy) return;
    setContrBusy(true);
    setContrError('');
    setContrResult(null);
    try {
      const res = await fetch('/api/public/verify-contract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, secret }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? 'Verification failed (' + res.status + ')');
      }
      setContrResult(body?.data ?? null);
    } catch (err) {
      setContrError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setContrBusy(false);
    }
  };

  const resetContract = () => {
    setContrResult(null);
    setContrError('');
    setContrCode('');
    setContrSecret('');
  };

  const result = str(data?.result ?? '');
  const ok = result === 'AUTHENTIC' || result === 'VERIFIED';
  const ream = data?.ream;
  const carton = data?.carton;
  const members = Array.isArray(carton?.members) ? carton.members : [];

  const warn = result === 'SUSPICIOUS' || result === 'ALREADY_VERIFIED';
  const tone = ok ? 'ok' : warn ? 'warn' : 'bad';
  const heroTitle = ok ? 'Authentic product' : warn ? 'Verification warning' : 'Not verified';
  const heroText = ok
    ? 'This QR is genuine and has not been tampered with.'
    : warn
      ? 'This QR was seen before or shows signs of tampering.'
      : 'We could not confirm this QR. It may be counterfeit, void, or invalid.';
  const reset = () => {
    setPayload('');
    setData(null);
    setError('');
    setDocResult(null);
    setDocError('');
    setDocToken('');
    setContrResult(null);
    setContrError('');
    setContrCode('');
    setContrSecret('');
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Verify Authenticity</h1>
          <p className="muted">Public authenticity portal for {company.name} reams, cartons and employment contracts.</p>
        </div>
      </header>

      <section className="card">
        <form onSubmit={verify} className="stack">
          <label className="field">
            <span>QR payload or code</span>
            <input
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="RE-2026-00000001|secret  (scan the label QR or paste the payload)"
              autoComplete="off"
            />
          </label>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy || !payload.trim()}>
            {busy ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </section>

      {docToken && (
        <section className={`card ${docResult?.valid ? 'scan-verified' : ''}`} style={{ marginTop: 16 }}>
          <div className={`result-hero ${docResult ? (docResult.valid ? 'ok' : 'warn') : ''}`}>
            <div className="hero-icon" aria-hidden>
              {docBusy ? '?' : docResult ? (docResult.valid ? 'OK' : '!') : '?'}
            </div>
            <div>
              <h2>{docBusy ? 'Checking document...' : docResult?.valid ? 'Document is authentic' : docResult ? 'Document could not be verified' : 'Document verification'}</h2>
              <p>
                {docBusy
                  ? 'Confirming the signed document against the ERP registry.'
                  : docResult?.valid
                    ? 'This exported document is genuine and has not been altered since it was issued.'
                    : docResult?.reason === 'INVALID_TOKEN'
                      ? 'The verification link is invalid or incomplete.'
                      : 'This document could not be confirmed. It may have been modified, deleted, or the link may be invalid.'}
              </p>
              {!docBusy && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={reset} style={{ marginTop: 8 }}>
                  Verify another
                </button>
              )}
            </div>
          </div>
          {docError && <div className="alert alert-error" style={{ marginTop: 12 }}>{docError}</div>}
          {docResult && (
            <>
            <dl className="detail-list" style={{ marginTop: 12 }}>
              <div className="detail-row">
                <dt>Status</dt>
                <dd><strong>{docResult.valid ? 'VERIFIED' : 'TAMPERED / INVALID'}</strong></dd>
              </div>
              {str(docResult.title) && (
                <div className="detail-row"><dt>Document</dt><dd>{docResult.title}</dd></div>
              )}
              {str(docResult.code) && (
                <div className="detail-row"><dt>Reference</dt><dd className="cell-mono">{docResult.code}</dd></div>
              )}
              {str(docResult.companyName) && (
                <div className="detail-row"><dt>Issuing company</dt><dd>{docResult.companyName}</dd></div>
              )}
              {str(docResult.issuer) && (
                <div className="detail-row"><dt>Exported by</dt><dd>{docResult.issuer}</dd></div>
              )}
              {str(docResult.issuedAt) && (
                <div className="detail-row"><dt>Issued at</dt><dd>{fmtDate(docResult.issuedAt)}</dd></div>
              )}
              {str(docResult.fingerprint) && (
                <div className="detail-row">
                  <dt>SHA-256 fingerprint</dt>
                  <dd className="cell-mono" style={{ fontSize: 11 }}>{docResult.fingerprint}</dd>
                </div>
              )}
            </dl>
            {docResult.company && <VerifyCompany company={docResult.company} />}
            </>
          )}
        </section>
      )}

      {data && (
        <section className={`card ${ok ? 'scan-verified' : ''}`} style={{ marginTop: 16 }}>
          <div className={`result-hero ${tone}`}>
            <div className="hero-icon" aria-hidden>
              {ok ? 'OK' : warn ? '!' : 'X'}
            </div>
            <div>
              <h2>{heroTitle}</h2>
              <p>{heroText}</p>
              <button type="button" className="btn btn-sm btn-ghost" onClick={reset} style={{ marginTop: 8 }}>
                Verify another
              </button>
            </div>
          </div>

          <div className="chips" style={{ marginTop: 14 }}>
            {data.code && (
              <div className="chip">
                <span className="chip-k">Code</span>
                <b className="cell-mono">{data.code}</b>
                <CopyButton value={data.code} label="Copy" />
              </div>
            )}
            {str(data.product_code ?? data.productCode) && (
              <div className="chip">
                <span className="chip-k">Product code</span>
                <b className="cell-mono">{str(data.product_code ?? data.productCode)}</b>
              </div>
            )}
            {str(data.batch_no ?? data.batchNo) && (
              <div className="chip">
                <span className="chip-k">Batch</span>
                <b className="cell-mono">{str(data.batch_no ?? data.batchNo)}</b>
                <CopyButton value={str(data.batch_no ?? data.batchNo)} label="Copy" />
              </div>
            )}
          </div>

          <div className="copy-row" style={{ marginTop: 10 }}>
            <span className="chip-k">Payload</span>
            <code className="cell-mono">{payload.trim()}</code>
            <CopyButton value={payload.trim()} label="Copy" />
          </div>

          <dl className="detail-list">
            <div className="detail-row"><dt>Result</dt><dd><strong>{result}</strong> <Badge value={result} /></dd></div>
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

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Verify an employment contract</h3>
          <p className="muted" style={{ margin: '2px 0 0' }}>
            Confirm a signed contract against the HR registry using the code and secret printed on the document or QR.
          </p>
        </div>
        <form onSubmit={verifyContract} className="stack" style={{ marginTop: 10 }}>
          <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label className="field">
              <span>Contract code</span>
              <input
                value={contrCode}
                onChange={(e) => setContrCode(e.target.value)}
                placeholder="CON-2026-000001  (code from the QR or document)"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Secret code</span>
              <input
                value={contrSecret}
                onChange={(e) => setContrSecret(e.target.value)}
                placeholder="One-time secret shown with the code"
                autoComplete="off"
              />
            </label>
          </div>
          {contrError && <div className="alert alert-error">{contrError}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={contrBusy || !contrCode.trim() || !contrSecret.trim()}>
              {contrBusy ? 'Verifying...' : 'Verify contract'}
            </button>
            {contrResult?.valid && (
              <button type="button" className="btn btn-ghost" onClick={resetContract}>
                Verify another
              </button>
            )}
          </div>
        </form>
        {contrResult && (
          <div className={contrResult.valid ? 'result-hero ok' : 'result-hero warn'} style={{ marginTop: 14 }}>
            <div className="hero-icon" aria-hidden>{contrResult.valid ? 'OK' : '!'}</div>
            <div>
              <h2>{contrResult.valid ? 'Contract is authentic' : 'Contract could not be verified'}</h2>
              <p>
                {contrResult.valid
                  ? 'This employment contract is registered in the HR system and is genuine.'
                  : 'We could not confirm this contract. The code or secret may be incorrect, or the record is no longer verifiable.'}
              </p>
            </div>
          </div>
        )}
        {contrResult && (
          <dl className="detail-list" style={{ marginTop: 12 }}>
            <div className="detail-row">
              <dt>Status</dt>
              <dd><strong>{contrResult.valid ? 'VERIFIED' : 'NOT VERIFIED'}</strong></dd>
            </div>
            {str(contrResult.status) && (
              <div className="detail-row"><dt>Contract status</dt><dd>{contrResult.status}</dd></div>
            )}
            {str(contrResult.document_no) && (
              <div className="detail-row"><dt>Document no</dt><dd className="cell-mono">{contrResult.document_no}</dd></div>
            )}
            {str(contrResult.document_type) && (
              <div className="detail-row"><dt>Document type</dt><dd>{contrResult.document_type}</dd></div>
            )}
            {str(contrResult.first_verified_at) && (
              <div className="detail-row"><dt>First verified</dt><dd>{fmtDate(contrResult.first_verified_at)}</dd></div>
            )}
            {typeof contrResult.verify_count === 'number' && (
              <div className="detail-row"><dt>Verification count</dt><dd>{contrResult.verify_count}</dd></div>
            )}
          </dl>
        )}
      </section>

      <p className="hint" style={{ marginTop: 12 }}>
        Tip: the same QR can also be scanned at <code>/verify</code>. Each unique ream carries its own
        unforgeable payload; a carton QR links the 5 reams packed inside it.
      </p>
    </div>
  );
}

const isHexColor = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

function CompanyMark({ navy, teal, size = 40 }: { navy: string; teal: string; size?: number }) {
  return (
    <svg className="verify-company-mark" viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <rect width="40" height="40" rx="8" fill={navy} />
      <rect x="8" y="8" width="6.2" height="24" rx="1.2" fill="#fff" />
      <rect x="25.8" y="8" width="6.2" height="24" rx="1.2" fill="#fff" />
      <rect x="8" y="17" width="24" height="6" rx="1" fill={teal} />
      <rect x="18.6" y="14.4" width="2.8" height="11.2" rx="0.4" fill="#fff" />
      <rect x="14.4" y="18.6" width="11.2" height="2.8" rx="0.4" fill="#fff" />
    </svg>
  );
}

/** Branded issuing-company block shown on public document verification results. */
function VerifyCompany({ company }: { company: CompanyInfo }) {
  const name = str(company.name);
  if (!name) return null;
  const navy = isHexColor(str(company.brand_color)) ? str(company.brand_color) : '#1261A0';
  const teal = isHexColor(str(company.brand_color_secondary)) ? str(company.brand_color_secondary) : '#00A6A6';
  const logo = /^https?:\/\//i.test(str(company.logo_url)) ? str(company.logo_url) : '';
  const tagline = str(company.tagline);
  const legal = str(company.legal_name);
  const email = str(company.email);
  const phone = str(company.phone);
  const website = str(company.website);
  const address = str(company.address);
  const verifyUrl = str(company.verify_url);
  const contacts = [
    email && { k: 'Email', v: email, href: `mailto:${email}`, external: false },
    phone && { k: 'Phone', v: phone, href: `tel:${phone.replace(/[^+\d]/g, '')}`, external: false },
    website && { k: 'Website', v: website, href: /^https?:\/\//i.test(website) ? website : `https://${website}`, external: true },
  ].filter(Boolean) as { k: string; v: string; href: string; external: boolean }[];
  return (
    <div className="verify-company">
      <div className="verify-company-head">
        <div className="verify-company-brand">
          {logo ? (
            <img
              className="verify-company-logo"
              src={logo}
              alt={`${name} logo`}
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <CompanyMark navy={navy} teal={teal} />
          )}
          <div>
            <p className="verify-company-name" style={{ color: navy }}>
              {name}
            </p>
            {tagline && (
              <p className="verify-company-tag" style={{ color: teal }}>
                {tagline.toUpperCase()}
              </p>
            )}
            {legal && legal !== name && <p className="verify-company-legal">{legal}</p>}
          </div>
        </div>
        <span className="badge badge-blue">Issuing company</span>
      </div>
      <div className="verify-company-rules">
        <span style={{ background: navy }} />
        <span style={{ background: teal }} />
      </div>
      {(contacts.length > 0 || address) && (
        <div className="verify-company-grid">
          {address && (
            <div className="verify-company-item">
              <span className="verify-company-k">Address</span>
              <span className="verify-company-v">{address}</span>
            </div>
          )}
          {contacts.map((c) => (
            <div className="verify-company-item" key={c.k}>
              <span className="verify-company-k">{c.k}</span>
              <a className="verify-company-v" href={c.href} target={c.external ? '_blank' : undefined} rel="noreferrer">
                {c.v}
              </a>
            </div>
          ))}
        </div>
      )}
      <div className="verify-company-foot">
        <div className="verify-company-swatches">
          <span className="verify-company-swatch">
            <i style={{ background: navy }} /> {navy.toUpperCase()}
          </span>
          <span className="verify-company-swatch">
            <i style={{ background: teal }} /> {teal.toUpperCase()}
          </span>
        </div>
        {verifyUrl && (
          <div className="verify-company-link">
            <span className="chip-k">Verify portal</span>
            <code className="cell-mono">{verifyUrl}</code>
            <CopyButton value={verifyUrl} label="Copy" />
          </div>
        )}
      </div>
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


function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
