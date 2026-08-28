import { useCallback, useEffect, useState } from 'react';
import { api, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';

type Rec = Record<string, unknown>;

export default function EmployeeIdentity({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const id = parts[2] ?? null;
  if (id) return <EmployeeDesk id={Number(id)} />;
  return <IdentityCentre />;
}

function IdentityCentre() {
  const { user } = useAuth();
  const [dash, setDash] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '25', page: String(page) });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { items: Rec[]; total: number } }>(`/api/ops/hr/identity?${p}`)
      .then((r) => { setRows(r.data.items ?? []); setTotal(Number(r.data.total ?? 0)); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Identity list failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hr/identity/dashboard')
      .then((r) => setDash(r.data))
      .catch(() => undefined);
  }, []);
  if (error && !dash) return <ErrorBanner error={error} />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR & payroll</p>
          <h1>Employee IDs</h1>
          <p className="muted">Permanent official IDs, short badges, QR identities and physical ID cards for the whole workforce.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.employees.create') && (
            <button className="btn btn-primary" onClick={() => navigate('/people/employees/new')}>New employee</button>
          )}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Total employees</span><span className="kpi-value">{Number(dash?.totalEmployees ?? 0)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Active</span><span className="kpi-value">{Number(dash?.activeEmployees ?? 0)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Pending IDs</span><span className="kpi-value">{Number(dash?.pendingIds ?? 0)}</span></div>
        <div className="kpi-card"><span className="kpi-label">New IDs this month</span><span className="kpi-value">{Number(dash?.newIdsThisMonth ?? 0)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Cards expiring 60d</span><span className="kpi-value">{Number(dash?.cardsExpiring_60 ?? 0)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Lost / damaged</span><span className="kpi-value">{Number(dash?.lostDamagedCards ?? 0)}</span></div>
      </div>
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search ID, name, dept, position..." />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option>ACTIVE</option><option>PROBATION</option><option>SUSPENDED</option>
          <option>ON_LEAVE</option><option>TERMINATED</option><option>RESIGNED</option><option>ARCHIVED</option>
        </select>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Official ID</th><th>Badge</th><th>Name</th><th>Department</th><th>Position</th><th>Status</th><th className="cell-num">Cards</th><th>QR</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/employee-ids/${r.id}`)}>
                <td className="cell-mono">{String(r.employeeNumber ?? '-')}</td>
                <td className="cell-mono">{String(r.shortEmployeeNumber ?? '-')}</td>
                <td>{String(r.firstName ?? '')} {String(r.lastName ?? '')}</td>
                <td>{String(r.departmentName ?? '-')}</td>
                <td>{String(r.position ?? '-')}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{Number(r.activeCards ?? 0)}</td>
                <td>{Number(r.hasQr ?? 0) > 0 ? <span className="badge badge-ok"><span className="badge-icon" aria-hidden>?</span>yes</span> : <span className="badge badge-neutral"><span className="badge-icon" aria-hidden>?</span>-</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No employee identities yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={25} total={total} onPage={setPage} />
    </div>
  );
}

function EmployeeDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [qrResult, setQrResult] = useState<Rec | null>(null);
  const [scanToken, setScanToken] = useState('');
  const [modal, setModal] = useState<'' | 'card' | 'replace' | 'suspend' | 'transfer'>('');
  const [reason, setReason] = useState('');
  const [targetCard, setTargetCard] = useState<Rec | null>(null);
  const [txDepartment, setTxDepartment] = useState('');
  const [txBranch, setTxBranch] = useState('');
  const [txPosition, setTxPosition] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/hr/identity/employees/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employee identity failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (label: string, path: string, body?: Record<string, unknown>) => {
    setBusy(label); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      if (label === 'Generate QR') setQrResult(r.data);
      if (label === 'Generate ID') setNotice(`Official ${String(r.data.official ?? '')} / ${String(r.data.short ?? '')}`);
      if (label === 'Issue card') setNotice(`Card ${String(r.data.cardNo ?? '')} issued`);
      if (label === 'Suspend card') setNotice(`Card ${String(r.data.cardNo ?? '')} suspended`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy('');
    }
  };
  const scan = async (token: string) => {
    setBusy('Scan'); setQrResult(null); setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/hr/identity/qr/scan', { method: 'POST', body: JSON.stringify({ token }) });
      setQrResult(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setBusy('');
    }
  };
  const verifyPublic = async (token: string) => {
    setBusy('Verify'); setQrResult(null); setError('');
    try {
      const r = await api<{ data: Rec }>('/api/public/verify-employee', { method: 'POST', body: JSON.stringify({ token }) });
      setQrResult(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verify failed');
    } finally {
      setBusy('');
    }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Loading identity..." />;
  const emp = (doc.employee ?? {}) as Rec;
  const identities = (doc.identities ?? []) as Rec[];
  const cards = (doc.cards ?? []) as Rec[];
  const assignments = (doc.assignments ?? []) as Rec[];
  const qr = identities.find((i) => String(i.identityType) === 'QR_IDENTITY');
  const official = identities.find((i) => String(i.identityType) === 'OFFICIAL_EMPLOYEE_ID');
  const name = `${String(emp.firstName ?? '')} ${String(emp.lastName ?? '')}`;
  const downloadPdf = async () => {
    setPdfBusy(true); setError(''); setNotice('');
    try {
      await openDocument('employee-id', id, 'pdf', `${String(emp.employeeNumber ?? 'employee')}-id-card.pdf`);
      setNotice('Employee ID card PDF downloaded');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setPdfBusy(false);
    }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Employee identity</p>
          <h1>{name}</h1>
          <p className="muted">
            <span className="cell-mono">{String(emp.employeeNumber ?? 'No official ID yet')}</span>
            {' / '}
            <span className="cell-mono">{String(emp.shortEmployeeNumber ?? '-')}</span>
            {' - '}{String(emp.position ?? emp.positionTitle ?? '-')}
            {' - '}{String(emp.departmentName ?? '-')}
            {' - '}{String(emp.branchName ?? '-')}
          </p>
        </div>
        <div className="head-actions">
          <Badge value={emp.status} />
          {can(user, 'hr.employee_identity.generate') && (
            <button className="btn" disabled={!!busy} onClick={() => act('Generate ID', `/api/ops/hr/identity/employees/${id}/generate`)}>{busy === 'Generate ID' ? 'Working...' : 'Generate ID'}</button>
          )}
          {can(user, 'hr.employee_qr.generate') && (
            <button className="btn" disabled={!!busy} onClick={() => act('Generate QR', `/api/ops/hr/identity/employees/${id}/qr`)}>{busy === 'Generate QR' ? 'Working...' : 'QR'}</button>
          )}
          {can(user, 'hr.employee_card.generate') && (
            <button className="btn" disabled={!!busy} onClick={() => act('New card', `/api/ops/hr/identity/employees/${id}/cards`)}>{busy === 'New card' ? 'Working...' : 'New card'}</button>
          )}
          {can(user, 'hr.employee_identity.view') && (
            <button className="btn" disabled={!!busy || pdfBusy} onClick={() => downloadPdf()}>{pdfBusy ? 'Working...' : 'Download PDF'}</button>
          )}
          {can(user, 'hr.employee_assignments.create') && (
            <button className="btn btn-primary" onClick={() => setModal('transfer')}>Transfer</button>
          )}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h3>Identities</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th>Reference</th><th>Status</th><th>Issued</th></tr></thead>
              <tbody>
                {identities.map((i) => (
                  <tr key={String(i.id)}>
                    <td>{String(i.identityType ?? '').replace(/_/g, ' ')}</td>
                    <td className="cell-mono">{String(i.identityNumber ?? '-')}</td>
                    <td><Badge value={i.status} /></td>
                    <td>{i.issuedAt ? String(i.issuedAt).slice(0, 10) : '-'}</td>
                  </tr>
                ))}
                {identities.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No identities yet. Generate the official ID first.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>QR verification</h3></div>
          {qr ? (
            <div style={{ padding: 16 }}>
              <p className="muted">Opaque secure token - scans resolve server-side. Public scans only expose name, department, position and status.</p>
              <p className="cell-mono" style={{ margin: '8px 0' }}>{String(qr.identityNumber)}</p>
              {((qr.metadata as Rec | undefined)?.qrCode) != null && <p className="muted">Code: <span className="cell-mono">{String(((qr.metadata as Rec).qrCode as string))}</span></p>}
              {can(user, 'hr.employee_qr.scan') && (
                <div className="toolbar" style={{ margin: '12px 0' }}>
                  <input className="search-input" value={scanToken} onChange={(e) => setScanToken(e.target.value)} placeholder="Paste token to scan..." />
                  <button className="btn" disabled={!!busy || !scanToken.trim()} onClick={() => scan(scanToken.trim())}>Internal scan</button>
                  <button className="btn" disabled={!!busy || !scanToken.trim()} onClick={() => verifyPublic(scanToken.trim())}>Public verify</button>
                </div>
              )}
              {qrResult && (
                <pre className="code-block" style={{ margin: 0 }}>{JSON.stringify(qrResult, null, 2)}</pre>
              )}
            </div>
          ) : (
            <p className="muted" style={{ padding: 16 }}>No QR identity yet. Generate one to enable scanning and verification.</p>
          )}
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h3>ID cards ({cards.length})</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Card no</th><th>Serial</th><th>Status</th><th>Issued</th><th>Expiry</th><th>Replaced by</th><th></th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={String(c.id)}>
                  <td className="cell-mono">{String(c.cardNo ?? '-')}</td>
                  <td className="cell-mono">{String(c.serialNumber ?? '-')}</td>
                  <td><Badge value={c.status} /></td>
                  <td>{c.issueDate ? String(c.issueDate).slice(0, 10) : '-'}</td>
                  <td>{c.expiryDate ? String(c.expiryDate).slice(0, 10) : '-'}</td>
                  <td>{c.replacedByCardId ? String(c.replacedByCardId) : '-'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {can(user, 'hr.employee_card.issue') && String(c.status) === 'DRAFT' && (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => act('Issue card', `/api/ops/hr/identity/cards/${c.id}/issue`)}>Issue</button>
                    )}
                    {can(user, 'hr.employee_card.suspend') && ['ACTIVE', 'LOST', 'DAMAGED'].includes(String(c.status)) && (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => { setTargetCard(c); setReason(''); setModal('suspend'); }}>Suspend</button>
                    )}
                    {can(user, 'hr.employee_card.replace') && ['ACTIVE', 'LOST', 'DAMAGED', 'SUSPENDED'].includes(String(c.status)) && (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => { setTargetCard(c); setReason(''); setModal('replace'); }}>Replace</button>
                    )}
                  </td>
                </tr>
              ))}
              {cards.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No cards yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Assignments & transfers</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Type</th><th>Department</th><th>Branch</th><th>Position</th><th>Effective</th><th>Reason</th></tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={String(a.id)}>
                  <td>{String(a.assignmentType ?? '-')}</td>
                  <td>{String(a.departmentName ?? `#${String(a.departmentId ?? '-')}`)}</td>
                  <td>{String(a.branchName ?? `#${String(a.branchId ?? '-')}`)}</td>
                  <td>{String(a.position ?? '-')}</td>
                  <td>{a.effectiveFrom ? String(a.effectiveFrom).slice(0, 10) : '-'}</td>
                  <td>{String(a.reason ?? '-')}</td>
                </tr>
              ))}
              {assignments.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No assignments recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {official && (
        <p className="muted" style={{ marginTop: 12 }}>Official employee ID {String(official.identityNumber)} is permanent. Transfers, promotions and card replacements never change it.</p>
      )}
      {modal === 'transfer' && (
        <Modal title={`Transfer ${name}`} onClose={() => setModal('')}
          footer={<>
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={!!busy} onClick={async () => {
              setBusy('Transfer'); setError(''); setNotice('');
              try {
                const body: Record<string, unknown> = { assignmentType: 'TRANSFER', reason: reason || null };
                if (txDepartment) body.departmentId = Number(txDepartment);
                if (txBranch) body.branchId = Number(txBranch);
                if (txPosition.trim()) body.position = txPosition.trim();
                await api(`/api/ops/hr/identity/employees/${id}/assignments`, { method: 'POST', body: JSON.stringify(body) });
                setNotice('Assignment recorded');
                setModal(''); load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Transfer failed');
              } finally { setBusy(''); }
            }}>{busy === 'Transfer' ? 'Working...' : 'Record transfer'}</button>
          </>}>
          <div className="form-grid">
            <label>Branch ID<input className="input" value={txBranch} onChange={(e) => setTxBranch(e.target.value)} placeholder="e.g. 2" /></label>
            <label>Department ID<input className="input" value={txDepartment} onChange={(e) => setTxDepartment(e.target.value)} placeholder="e.g. 16" /></label>
            <label>Position<input className="input" value={txPosition} onChange={(e) => setTxPosition(e.target.value)} placeholder="New position title" /></label>
            <label>Reason<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Transfer reason" /></label>
          </div>
        </Modal>
      )}
      {modal === 'replace' && targetCard && (
        <Modal title={`Replace card ${String(targetCard.cardNo ?? '')}`} onClose={() => setModal('')}
          footer={<>
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={!!busy} onClick={async () => {
              setBusy('Replace'); setError(''); setNotice('');
              try {
                const r = await api<{ data: Rec }>(`/api/ops/hr/identity/cards/${targetCard.id}/replace`, { method: 'POST', body: JSON.stringify({ reason: reason || 'Replacement' }) });
                setNotice(`New card ${String(((r.data?.newCard as Rec | undefined)?.cardNo ?? ''))} issued; old card voided`);
                setModal(''); load();
              } catch (e) { setError(e instanceof Error ? e.message : 'Replace failed'); } finally { setBusy(''); }
            }}>{busy === 'Replace' ? 'Working...' : 'Replace card'}</button>
          </>}>
          <p className="muted">The employee keeps the same official ID. The old card is voided permanently and a new card is issued.</p>
          <label>Reason<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lost / damaged / etc." /></label>
        </Modal>
      )}
      {modal === 'suspend' && targetCard && (
        <Modal title={`Suspend card ${String(targetCard.cardNo ?? '')}`} onClose={() => setModal('')}
          footer={<>
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-danger" disabled={!!busy} onClick={async () => {
              setBusy('Suspend'); setError(''); setNotice('');
              try {
                await api(`/api/ops/hr/identity/cards/${targetCard.id}/suspend`, { method: 'POST', body: JSON.stringify({ reason: reason || 'Suspended' }) });
                setNotice('Card suspended'); setModal(''); load();
              } catch (e) { setError(e instanceof Error ? e.message : 'Suspend failed'); } finally { setBusy(''); }
            }}>{busy === 'Suspend' ? 'Working...' : 'Suspend card'}</button>
          </>}>
          <label>Reason<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this card suspended?" /></label>
        </Modal>
      )}
    </div>
  );
}
