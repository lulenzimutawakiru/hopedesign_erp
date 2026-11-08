import { useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api';
import { can, useAuth } from '../auth';
import { navigate } from '../router';

interface SignRequest {
  id: number;
  code: string;
  title: string;
  message?: string | null;
  status: string;
  signatureOrder?: string | null;
  documentType?: string | null;
  documentCode?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  storageKey?: string | null;
  expiresAt?: string | null;
  sentAt?: string | null;
  completedAt?: string | null;
  revokedReason?: string | null;
  createdAt?: string | null;
  creatorFirstName?: string | null;
  creatorLastName?: string | null;
  signerCount?: number;
  signedCount?: number;
  [k: string]: unknown;
}

interface Signer {
  id: number;
  signerType?: string | null;
  signerUserId?: number | null;
  signerName?: string | null;
  signerEmail?: string | null;
  orderIndex?: number | null;
  status?: string | null;
  sentAt?: string | null;
  viewedAt?: string | null;
  signedAt?: string | null;
  declinedAt?: string | null;
  declineReason?: string | null;
  signature?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  [k: string]: unknown;
}

interface DirUser {
  id: number;
  username?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  status?: string | null;
  employeeId?: number | null;
}

type SignerDraft = {
  signerType: 'EMPLOYEE' | 'CONTACT';
  signerUserId?: number;
  signerName?: string;
  signerEmail?: string;
};

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const STATUS_TONE: Record<string, { color: string; bg: string }> = {
  DRAFT: { color: '#475569', bg: '#e2e8f0' },
  SENT: { color: '#1d4ed8', bg: '#dbeafe' },
  PARTIALLY_SIGNED: { color: '#b45309', bg: '#fef3c7' },
  COMPLETED: { color: '#15803d', bg: '#dcfce7' },
  REFUSED: { color: '#b91c1c', bg: '#fee2e2' },
  EXPIRED: { color: '#475569', bg: '#f1f5f9' },
  REVOKED: { color: '#6d28d9', bg: '#ede9fe' },
  SIGNED: { color: '#15803d', bg: '#dcfce7' },
  VIEWED: { color: '#0369a1', bg: '#e0f2fe' },
  NOT_SENT: { color: '#475569', bg: '#f1f5f9' },
};

function StatusPill({ status }: { status?: string | null }) {
  const t = STATUS_TONE[s(status).toUpperCase()] ?? STATUS_TONE.NOT_SENT;
  return (
    <span
      className="badge"
      style={{ color: t.color, background: t.bg, border: '1px solid ' + t.color + '33' }}
    >
      {s(status)}
    </span>
  );
}

const label = (v: unknown, fallback = '—') => (v === null || v === undefined || s(v).length === 0 ? fallback : s(v));

function fullName(u: { firstName?: string | null; lastName?: string | null; signerName?: string | null }) {
  if (u.firstName || u.lastName) return `${s(u.firstName)} ${s(u.lastName)}`.trim();
  return s(u.signerName);
}

export default function SignRequests({ path }: { path: string }) {
  const { user } = useAuth();
  const idFromPath = (() => {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'esign') return null;
    const n = Number(parts[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const [list, setList] = useState<SignRequest[] | null>(null);
  const [detail, setDetail] = useState<{ request: SignRequest; signers: Signer[] } | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Composer state.
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [documentType, setDocumentType] = useState('GENERAL');
  const [documentCode, setDocumentCode] = useState('');
  const [signatureOrder, setSignatureOrder] = useState<'ANY' | 'SEQUENTIAL'>('ANY');
  const [expiresAt, setExpiresAt] = useState('');
  const [signers, setSigners] = useState<SignerDraft[]>([]);
  const [docFile, setDocFile] = useState<{ name: string; mimeType: string; dataUrl: string } | null>(null);
  const [dirUsers, setDirUsers] = useState<DirUser[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const canCreate = can(user, 'sign.sign_requests.create');
  const canSend = can(user, 'sign.sign_requests.send');
  const canRevoke = can(user, 'sign.sign_requests.revoke');
  const canUpdate = can(user, 'sign.sign_requests.update');
  const canDelete = can(user, 'sign.sign_requests.delete');

  const loadList = async () => {
    setError('');
    try {
      const r = await api<{ data: SignRequest[] }>('/api/ops/sign');
      setList(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sign requests');
    }
  };

  const loadDetail = async (id: number) => {
    setError('');
    setDetail(null);
    try {
      const r = await api<{ data: { request: SignRequest; signers: Signer[] } }>(`/api/ops/sign/${id}/detail`);
      setDetail(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sign request');
    }
  };

  useEffect(() => {
    if (composing) return;
    if (idFromPath != null) void loadDetail(idFromPath);
    else void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idFromPath, composing]);

  useEffect(() => {
    if (!composing) return;
    api<{ data: DirUser[] }>('/api/ops/hr/directory/users?q=')
      .then((r) => setDirUsers(r.data ?? []))
      .catch(() => setDirUsers([]));
  }, [composing]);

  const resetComposer = () => {
    setTitle('');
    setMessage('');
    setDocumentType('GENERAL');
    setDocumentCode('');
    setSignatureOrder('ANY');
    setExpiresAt('');
    setSigners([]);
    setDocFile(null);
    setError('');
  };

  const openComposer = () => {
    resetComposer();
    setComposing(true);
  };

  const addSigner = (type: 'EMPLOYEE' | 'CONTACT') => {
    setSigners((prev) => [...prev, { signerType: type }]);
  };

  const updateSigner = (idx: number, patch: Partial<SignerDraft>) => {
    setSigners((prev) => prev.map((sg, i) => (i === idx ? { ...sg, ...patch } : sg)));
  };

  const removeSigner = (idx: number) => {
    setSigners((prev) => prev.filter((_, i) => i !== idx));
  };

  const onPickFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDocFile({ name: file.name, mimeType: file.type || 'application/octet-stream', dataUrl: String(reader.result) });
    };
    reader.readAsDataURL(file);
  };

  const create = async () => {
    if (!title.trim()) { setError('A title is required.'); return; }
    if (signers.length === 0) { setError('Add at least one signer.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        message: message.trim() || null,
        documentType: documentType || 'GENERAL',
        documentCode: documentCode.trim() || null,
        signatureOrder,
        expiresAt: expiresAt || null,
        signers: signers.map((sg) => ({
          signerType: sg.signerType,
          signerUserId: sg.signerType === 'EMPLOYEE' ? sg.signerUserId : undefined,
          signerName: sg.signerType === 'CONTACT' ? sg.signerName : undefined,
          signerEmail: sg.signerType === 'CONTACT' ? sg.signerEmail : undefined,
        })),
      };
      if (docFile) payload.document = docFile;
      const r = await api<{ data: SignRequest }>('/api/ops/sign', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const id = r.data?.id;
      if (id) {
        setComposing(false);
        navigate('/esign/' + id);
      } else {
        setComposing(false);
        navigate('/esign');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create sign request');
    } finally {
      setBusy(false);
    }
  };

  const send = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sign/${id}/send`, { method: 'POST', body: JSON.stringify({}) });
      await loadDetail(id);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sign/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'Revoked by requester' }) });
      await loadDetail(id);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: number) => {
    if (busy) return;
    if (!window.confirm('Delete this draft sign request? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sign/${id}`, { method: 'DELETE' });
      navigate('/esign');
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const signNow = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sign/${id}/sign`, {
        method: 'POST',
        body: JSON.stringify({ signature: `${s(user?.first_name)} ${s(user?.last_name)}`.trim(), signatureData: { method: 'in_app' }, consent: { agreed: true } }),
      });
      await loadDetail(id);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign');
    } finally {
      setBusy(false);
    }
  };

  const resend = async (signerId: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sign/signers/${signerId}/resend`, { method: 'POST', body: JSON.stringify({}) });
      if (idFromPath != null) await loadDetail(idFromPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resend');
    } finally {
      setBusy(false);
    }
  };

  const mySigner = detail?.signers.find((sg) => sg.signerUserId != null && sg.signerUserId === user?.id);

  // ---- Composer ----
  if (composing) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>New sign request</h1>
            <p className="muted">Collect signatures from staff or external contacts.</p>
          </div>
          <button className="btn btn-ghost" onClick={() => setComposing(false)}>Cancel</button>
        </header>

        <section className="card">
          <div className="stack">
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Supplier NDA for Q4" />
            </label>
            <label className="field">
              <span>Message</span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Instructions for the signer (optional)" />
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: '1 1 200px' }}>
                <span>Document type</span>
                <input value={documentType} onChange={(e) => setDocumentType(e.target.value)} />
              </label>
              <label className="field" style={{ flex: '1 1 200px' }}>
                <span>Reference code</span>
                <input value={documentCode} onChange={(e) => setDocumentCode(e.target.value)} placeholder="optional" />
              </label>
              <label className="field" style={{ flex: '1 1 200px' }}>
                <span>Signature order</span>
                <select value={signatureOrder} onChange={(e) => setSignatureOrder(e.target.value as 'ANY' | 'SEQUENTIAL')}>
                  <option value="ANY">Any order</option>
                  <option value="SEQUENTIAL">Sequential</option>
                </select>
              </label>
              <label className="field" style={{ flex: '1 1 200px' }}>
                <span>Expires</span>
                <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </label>
            </div>
            <div className="field">
              <span>Document file (optional)</span>
              <input
                ref={fileRef}
                type="file"
                onChange={(e) => onPickFile(e.target.files?.[0])}
              />
              {docFile && <p className="muted" style={{ marginTop: 4 }}>{docFile.name} — attached</p>}
            </div>
          </div>
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Signers</h3>
            <div className="chips">
              <button type="button" className="chip" onClick={() => addSigner('EMPLOYEE')}>+ Employee</button>
              <button type="button" className="chip" onClick={() => addSigner('CONTACT')}>+ Contact</button>
            </div>
          </div>
          {signers.length === 0 && <p className="muted">No signers added yet.</p>}
          <div className="stack">
            {signers.map((sg, idx) => (
              <div key={idx} className="card" style={{ padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span className="chip chip-k">{idx + 1}</span>
                  <select
                    value={sg.signerType}
                    onChange={(e) => updateSigner(idx, { signerType: e.target.value as 'EMPLOYEE' | 'CONTACT' })}
                  >
                    <option value="EMPLOYEE">Employee (in-app)</option>
                    <option value="CONTACT">External contact (email)</option>
                  </select>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeSigner(idx)}>Remove</button>
                </div>
                {sg.signerType === 'EMPLOYEE' ? (
                  dirUsers && dirUsers.length > 0 ? (
                    <label className="field">
                      <span>Employee</span>
                      <select
                        value={sg.signerUserId != null ? String(sg.signerUserId) : ''}
                        onChange={(e) => updateSigner(idx, { signerUserId: Number(e.target.value) })}
                      >
                        <option value="">Choose…</option>
                        {dirUsers.map((u) => (
                          <option key={u.id} value={u.id}>{fullName({ firstName: u.firstName, lastName: u.lastName })} — {s(u.email)}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="field">
                      <span>User ID</span>
                      <input
                        type="number"
                        value={sg.signerUserId ?? ''}
                        onChange={(e) => updateSigner(idx, { signerUserId: Number(e.target.value) })}
                        placeholder="Enter the employee's user ID"
                      />
                    </label>
                  )
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <label className="field" style={{ flex: '1 1 200px' }}>
                      <span>Name</span>
                      <input value={sg.signerName ?? ''} onChange={(e) => updateSigner(idx, { signerName: e.target.value })} />
                    </label>
                    <label className="field" style={{ flex: '1 1 260px' }}>
                      <span>Email</span>
                      <input value={sg.signerEmail ?? ''} onChange={(e) => updateSigner(idx, { signerEmail: e.target.value })} />
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create request'}</button>
        </div>
      </div>
    );
  }

  // ---- Detail ----
  if (idFromPath != null) {
    const req = detail?.request;
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>{req ? `${req.code} · ${req.title}` : 'Sign request'}</h1>
            {req && (
              <p className="muted">
                {req.status} · {req.signerCount ?? 0} signer{(req.signerCount ?? 0) === 1 ? '' : 's'} · {req.signedCount ?? 0} signed
              </p>
            )}
          </div>
          <button className="btn btn-ghost" onClick={() => navigate('/esign')}>Back</button>
        </header>

        {error && <div className="alert alert-error">{error}</div>}

        {!detail && <div className="card"><p className="muted">Loading…</p></div>}

        {detail && req && (
          <>
            <section className="card">
              <div className="card-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <StatusPill status={req.status} />
                  {req.signatureOrder && <span className="chip">{req.signatureOrder}</span>}
                  {req.documentType && <span className="chip chip-k">{req.documentType}</span>}
                </div>
              </div>
              <dl className="detail-list" style={{ marginTop: 8 }}>
                {req.message && <div className="detail-row"><dt>Message</dt><dd>{req.message}</dd></div>}
                {req.documentCode && <div className="detail-row"><dt>Reference</dt><dd>{req.documentCode}</dd></div>}
                <div className="detail-row"><dt>Created</dt><dd>{fmtDate(req.createdAt)}</dd></div>
                {req.expiresAt && <div className="detail-row"><dt>Expires</dt><dd>{fmtDate(req.expiresAt)}</dd></div>}
                {req.sentAt && <div className="detail-row"><dt>Sent</dt><dd>{fmtDate(req.sentAt)}</dd></div>}
                {req.completedAt && <div className="detail-row"><dt>Completed</dt><dd>{fmtDate(req.completedAt)}</dd></div>}
                {req.revokedReason && <div className="detail-row"><dt>Revoke reason</dt><dd>{req.revokedReason}</dd></div>}
                {req.creatorFirstName && <div className="detail-row"><dt>Requested by</dt><dd>{fullName({ firstName: req.creatorFirstName, lastName: req.creatorLastName })}</dd></div>}
              </dl>
            </section>

            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <h3>Signers</h3>
                <div className="chips">
                  {(req.status === 'DRAFT') && (
                    <>
                      {canSend && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => send(req.id)}>Send</button>}
                      {canUpdate && <button className="btn btn-ghost btn-sm" onClick={() => { resetComposer(); setComposing(true); }}>Edit draft</button>}
                      {canDelete && <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => del(req.id)}>Delete</button>}
                    </>
                  )}
                  {(req.status === 'SENT' || req.status === 'PARTIALLY_SIGNED') && canRevoke && (
                    <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => revoke(req.id)}>Revoke</button>
                  )}
                  {mySigner && (mySigner.status === 'SENT' || mySigner.status === 'VIEWED') && (req.status === 'SENT' || req.status === 'PARTIALLY_SIGNED') && (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => signNow(req.id)}>Sign now</button>
                  )}
                </div>
              </div>
              <div className="table-wrap">
                <table className="table data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Signer</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Signed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.signers.map((sg) => (
                      <tr key={sg.id}>
                        <td className="cell-mono">{sg.orderIndex ?? '-'}</td>
                        <td>
                          <div>{label(sg.signerName, fullName(sg))}</div>
                          {sg.signerEmail && <div className="muted" style={{ fontSize: 12 }}>{sg.signerEmail}</div>}
                        </td>
                        <td><span className="chip chip-k">{label(sg.signerType)}</span></td>
                        <td><StatusPill status={sg.status} /></td>
                        <td>{sg.signedAt ? fmtDate(sg.signedAt) : '—'}</td>
                        <td>
                          {(sg.status === 'SENT' || sg.status === 'VIEWED') && (req.status === 'SENT' || req.status === 'PARTIALLY_SIGNED') && canSend && (
                            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => resend(sg.id)}>Resend</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    );
  }

  // ---- List ----
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sign Requests</h1>
          <p className="muted">Electronic signature envelopes for staff and external contacts.</p>
        </div>
        {canCreate && <button className="btn btn-primary" onClick={openComposer}>New request</button>}
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="card">
        {!list && <p className="muted">Loading…</p>}
        {list && list.length === 0 && <p className="muted">No sign requests yet.</p>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table className="table data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Signers</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/esign/' + r.id)}>
                    <td className="cell-mono">{r.code}</td>
                    <td>{r.title}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{r.signedCount ?? 0}/{r.signerCount ?? 0}</td>
                    <td>{fmtDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
