import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader, StaffPhoto } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { Avatar, HrEmptyState as EmptyState } from '../components/hrUi';
import { type Rec, shortDate } from './hrShared';

function UserAccountLink({
  employeeId, account, matches, canEdit, onChanged,
}: { employeeId: number; account: Rec | null; matches: Rec[]; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    if (!q.trim()) { setHits([]); return; }
    try {
      const r = await api<{ data: Rec[] }>(`/api/ops/hr/directory/users?unlinked=1&q=${encodeURIComponent(q.trim())}`);
      setHits(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    }
  };
  const link = async (userId: number) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${employeeId}/link-user`, { method: 'POST', body: JSON.stringify({ userId }) });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link');
    } finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${employeeId}/unlink-user`, { method: 'POST', body: '{}' });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlink');
    } finally { setBusy(false); }
  };
  if (account && account.id) {
    return (
      <div>
        {error && <ErrorBanner error={error} />}
        <dl className="def-list">
          <div><dt>Username</dt><dd className="cell-mono">{String(account.username || '—')}</dd></div>
          <div><dt>Email</dt><dd>{String(account.email || '—')}</dd></div>
          <div><dt>Status</dt><dd><Badge value={account.status} /></dd></div>
        </dl>
        <div className="action-group" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => navigate('/admin/users')}>Open user accounts</button>
          {canEdit && <button className="btn btn-sm" disabled={busy} onClick={() => void unlink()}>Unlink</button>}
        </div>
      </div>
    );
  }
  const options = hits.length ? hits : matches;
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <p className="muted">No ERP login is linked. Search an existing user account to connect payroll, leave and this file.</p>
      {canEdit && (
        <div className="toolbar">
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or email" onKeyDown={(ev) => { if (ev.key === 'Enter') void search(); }} />
          <button className="btn btn-sm" onClick={() => void search()}>Search</button>
        </div>
      )}
      {options.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data">
            <tbody>
              {options.map((row) => (
                <tr key={String(row.id)}>
                  <td className="cell-mono">{String(row.username ?? '')}</td>
                  <td>{String(row.email ?? '')}</td>
                  <td>{String(row.firstName ?? '')} {String(row.lastName ?? '')}</td>
                  <td>{canEdit && <button className="btn btn-sm" disabled={busy || row.employeeId != null} onClick={() => void link(Number(row.id))}>{row.employeeId != null ? 'Linked' : 'Link'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Register of employees with search, status filters and row actions. */
export function EmployeeList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (q.trim()) p.set('q', q.trim());
    api<{ data: { rows: Rec[] } }>(`/api/ops/hr/employees?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Employees</p>
          <h1>Headcount</h1>
          <p className="muted">Open a file to print contracts, book leave, or start payroll movements.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people')}>Board</button>
          <button className="btn btn-primary" onClick={() => navigate('/people/employees/new')}>New employee</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number…" />
        <span className="muted">{fmtNum(rows.length)} on this page</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Name</th><th>Dept</th><th>Position</th><th>ERP login</th><th>Status</th><th className="cell-num">Basic</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/employees/${r.id}`)}>
                <td className="cell-mono">{String(r.employeeNo)}</td>
                <td><Avatar name={String(r.firstName) + ' ' + String(r.lastName)} size="sm" /></td>
                <td>{String(r.departmentName ?? '—')}</td>
                <td>{String(r.position ?? '—')}</td>
                <td>{r.userId ? <span className="cell-mono">{String(r.userUsername ?? 'Linked')}</span> : <span className="muted">None</span>}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num td-strong">{fmtMoney(r.baseSalary)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7}><EmptyState icon="👤" title="No employees match" hint="Try a different search, or hire the first person on the file."><button className="btn btn-primary btn-sm" onClick={() => navigate('/people/employees/new')}>New employee</button></EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Employee 360 workspace: profile, contracts, leave, pay and career tabs.
 *
 * Loads the employee record plus its HCM timeline, and exposes the
 * lifecycle actions (movement, final settlement, photo, user link).
 */
export function EmployeeDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loanAmt, setLoanAmt] = useState('500000');
  const [loanDed, setLoanDed] = useState('50000');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [timeline, setTimeline] = useState<Rec[]>([]);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [movementType, setMovementType] = useState('TRANSFER');
  const [movementPositionId, setMovementPositionId] = useState('');
  const [movementEffective, setMovementEffective] = useState('');
  const [movementSalary, setMovementSalary] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [tab, setTab] = useState('overview');
  const [docBusy, setDocBusy] = useState('');
  const [photoRev, setPhotoRev] = useState(0);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; run: () => void } | null>(null);
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/hr/employees/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employee failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const loadTimeline = useCallback(() => {
    api<{ data: { events: Rec[] } }>(`/api/ops/hcm/employees/${id}/timeline`)
      .then((r) => setTimeline(r.data.events ?? []))
      .catch(() => undefined);
  }, [id]);
  useEffect(() => {
    loadTimeline();
    api<{ data: Rec[] }>('/api/hr/positions')
      .then((r) => setPositions(r.data ?? []))
      .catch(() => undefined);
  }, [loadTimeline]);
  const recordMovement = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/ops/hcm/movements', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: id,
          positionId: Number(movementPositionId),
          movementType,
          effectiveFrom: movementEffective,
          salary: movementSalary ? Number(movementSalary) : null,
          reason: movementReason.trim() || undefined,
        }),
      });
      setNotice('Movement recorded');
      setMovementPositionId('');
      setMovementEffective('');
      setMovementSalary('');
      setMovementReason('');
      load();
      loadTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening employee…" />;
  const e = doc.employee as Rec;

  const clockHere = (path: string, ok: string) => {
    if (!navigator.geolocation) {
      setError('This device cannot share its location. A clock-in is only recorded at the factory.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      await act(path, {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }, ok);
    }, () => {
      setBusy(false);
      setError('Allow location so the clock-in can be checked against the factory premises.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const prepareSettlement = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { finalSettlementId: number } }>(`/api/ops/hr/employees/${id}/final-settlement`, { method: 'POST', body: '{}' });
      navigate(`/people/final-settlements/${r.data.finalSettlementId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const openContractDoc = async (contract: Rec, format: 'pdf' | 'print') => {
    setDocBusy(String(contract.id) + format); setError('');
    try {
      await openDocument('employment-contract', contract.id, format, String(contract.contractNo ?? 'contract') + '.pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setDocBusy(''); }
  };
  const openPayslipDoc = async (slip: Rec, format: 'pdf' | 'print') => {
    setDocBusy('slip-' + String(slip.id) + format); setError('');
    try {
      await openDocument('payslip', slip.id, format, String(slip.payslipNo ?? 'payslip') + '.pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setDocBusy(''); }
  };
  const contracts = (doc.contracts as Rec[]) ?? [];
  const leaveRows = (doc.leave as Rec[]) ?? [];
  const slips = (doc.payslips as Rec[]) ?? [];
  const currentContract = contracts.find((c) => ['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(c.status ?? ''))) ?? contracts[0] ?? null;
  const fullName = String(e.firstName ?? '') + ' ' + String(e.lastName ?? '');
  const terminated = String(e.status) === 'TERMINATED';
  const hasPhoto = Boolean(doc.hasPhoto || e.photoPath);
  const attachPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'PASSPORT');
      await api(`/api/ops/hr/employees/${id}/photo`, { method: 'POST', body: fd });
      setNotice('Passport photograph attached. It will print on the employment contract.');
      setPhotoRev((n) => n + 1);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const tabs: Array<[string, string]> = [
    ['overview', 'Overview'],
    ['contracts', 'Contracts (' + contracts.length + ')'],
    ['leave', 'Leave'],
    ['pay', 'Pay'],
    ['career', 'Career'],
  ];
  return (
    <div className="page">
      <div className="emp-hero">
        <div className="photo-attach">
          <StaffPhoto path={'/api/ops/hr/employees/' + id + '/photo?r=' + photoRev} hasPhoto={hasPhoto} name={fullName} size={86} />
          {can(user, 'hr.employees.update') && (
            <label className="btn btn-sm">
              {hasPhoto ? 'Change photo' : 'Attach passport photo'}
              <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden disabled={busy} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; void attachPhoto(f); }} />
            </label>
          )}
        </div>
        <div className="emp-hero-copy">
          <p className="mod-kicker" data-mod="hr" style={{ marginBottom: 6 }}>Employee file</p>
          <h1>{fullName}</h1>
          <p>{String(e.position ?? 'No position')} · {String(e.departmentName ?? 'No department')}</p>
          <div className="emp-hero-facts">
            <div><span className="emp-hero-k">Employee no</span><span className="emp-hero-v cell-mono">{String(e.employeeNo)}</span></div>
            <div><span className="emp-hero-k">Status</span><span className="emp-hero-v"><Badge value={e.status} /></span></div>
            <div><span className="emp-hero-k">Basic salary</span><span className="emp-hero-v">{fmtMoney(e.baseSalary)}</span></div>
            <div><span className="emp-hero-k">Hire date</span><span className="emp-hero-v">{shortDate(e.hireDate)}</span></div>
            <div><span className="emp-hero-k">Current contract</span><span className="emp-hero-v">{currentContract ? String(currentContract.contractNo) : 'None on file'}</span></div>
            <div><span className="emp-hero-k">ERP login</span><span className="emp-hero-v">{doc.account ? String((doc.account as Rec).username || (doc.account as Rec).email) : 'Not linked'}</span></div>
            <div>
              <span className="emp-hero-k">Payroll</span>
              <span className="emp-hero-v">
                {e.payrollEnabled ? 'Enrolled' : 'Not enrolled'}
                {e.payrollGroupName ? ` (${String(e.payrollGroupName)})` : ''}
              </span>
            </div>
            <div><span className="emp-hero-k">Biometric user</span><span className="emp-hero-v cell-mono">{Array.isArray(doc.biometricUsers) && doc.biometricUsers.length ? doc.biometricUsers.map((b: Rec) => String(b.employeeIdentifier)).join(', ') : 'Not linked'}</span></div>
          </div>
        </div>
        <div className="emp-hero-actions">
          <button className="btn btn-sm" onClick={() => navigate('/people/employees')}>All employees</button>
          {can(user, 'hr.attendance.create') && !terminated && (
            <>
              <button className="btn" disabled={busy} onClick={() => clockHere(`/api/ops/hr/employees/${id}/clock-in`, 'Clocked in at the factory')}>Clock in</button>
              <button className="btn" disabled={busy} onClick={() => clockHere(`/api/ops/hr/employees/${id}/clock-out`, 'Clocked out at the factory')}>Clock out</button>
            </>
          )}
          {can(user, 'hr.contracts.create') && !terminated && (
            <button className="btn btn-primary" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>
          )}
          {can(user, 'hr.employees.update') && (
            <button className="btn" onClick={() => navigate(`/people/employees/${id}/edit`)}>Edit details</button>
          )}
          {can(user, 'hr.employees.terminate') && !terminated && (
            <button className="btn btn-warning" disabled={busy} onClick={() => {
              setConfirm({
                title: 'Terminate employee',
                body: `Terminate ${fullName}? This ends active employment, closes the current contract and stops future payroll for this employee. It is recorded on the employee file.`,
                label: 'Terminate employee',
                danger: true,
                run: () => act(`/api/ops/hr/employees/${id}/terminate`, {}, 'Terminated'),
              });
            }}>Terminate</button>
          )}
          {can(user, 'hr.final_settlements.create') && terminated && (
            <button className="btn btn-primary" disabled={busy} onClick={() => {
              setConfirm({
                title: 'Prepare final settlement',
                body: `Prepare a final settlement for ${fullName}? A draft settlement is created from their salary, leave balance and outstanding loans, then routed for approval.`,
                label: 'Prepare settlement',
                run: () => { void prepareSettlement(); },
              });
            }}>Final settlement</button>
          )}
        </div>
      </div>
      {notice && <div className="callout callout-success"><span className="callout-icon" aria-hidden>✓</span><div className="callout-body"><p>{notice}</p></div></div>}
      {error && <ErrorBanner error={error} />}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'overview' && (
        <div className="desk-panel people-split">
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>📄</span><div><h3>Employment</h3><p>Active terms at a glance.</p></div></div>
            {currentContract ? (
              <dl className="def-list">
                <div><dt>Contract</dt><dd className="cell-mono">{String(currentContract.contractNo)}</dd></div>
                <div><dt>Type</dt><dd><Badge value={currentContract.contractType} /></dd></div>
                <div><dt>Status</dt><dd><Badge value={currentContract.status} /></dd></div>
                <div><dt>Start</dt><dd>{shortDate(currentContract.startDate)}</dd></div>
                <div><dt>End</dt><dd>{currentContract.endDate ? shortDate(currentContract.endDate) : 'Open'}</dd></div>
              </dl>
            ) : (
              <EmptyState icon="📄" title="No contract on file" hint="Draft one so leave, payroll and print have a legal base.">
                {can(user, 'hr.contracts.create') && !terminated && <button className="btn btn-primary btn-sm" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>}
              </EmptyState>
            )}
            {currentContract && (
              <div className="action-group" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(currentContract.id))}>Open</button>
                {can(user, 'hr.contracts.view') && (
                  <>
                    <button className="btn btn-sm" disabled={Boolean(docBusy)} onClick={() => openContractDoc(currentContract, 'print')}>Print</button>
                    <button className="btn btn-sm" disabled={Boolean(docBusy)} onClick={() => openContractDoc(currentContract, 'pdf')}>PDF</button>
                  </>
                )}
              </div>
            )}
          </section>
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>🔐</span><div><h3>ERP user account</h3><p>Login used for approvals, self-service and the desk.</p></div></div>
            <UserAccountLink employeeId={id} account={(doc.account ?? null) as Rec | null} matches={(doc.accountMatches as Rec[]) ?? []} canEdit={can(user, 'hr.employees.update')} onChanged={load} />
          </section>
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>⚡</span><div><h3>Now</h3><p>What needs a decision on this file.</p></div></div>
            <dl className="def-list">
              <div><dt>Leave waiting</dt><dd>{fmtNum(leaveRows.filter((r) => String(r.status) === 'SUBMITTED').length)}</dd></div>
              <div><dt>Contracts</dt><dd>{fmtNum(contracts.length)}</dd></div>
              <div><dt>Payslips</dt><dd>{fmtNum(slips.length)}</dd></div>
              <div><dt>Timeline</dt><dd>{fmtNum(timeline.length)} events</dd></div>
            </dl>
          </section>
        </div>
      )}
      {tab === 'contracts' && (
        <section className="card desk-panel">
          <div className="card-head">
            <h3>Employment contracts</h3>
            {can(user, 'hr.contracts.create') && !terminated && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>
            )}
          </div>
          {contracts.length === 0 ? (
            <div className="card-pad"><EmptyState icon="📄" title="No contracts on file" hint="Attach a written contract so print includes every clause." /></div>
          ) : (
            <div className="doc-card-list">
              {contracts.map((r) => (
                <article key={String(r.id)} className="doc-card">
                  <div className="doc-card-main">
                    <div className="doc-card-top">
                      <span className="cell-mono">{String(r.contractNo ?? '-')}</span>
                      <Badge value={r.contractType} />
                      <Badge value={r.status} />
                    </div>
                    <p className="doc-card-meta">
                      {shortDate(r.startDate)} → {r.endDate ? shortDate(r.endDate) : 'Open'}
                      {r.jobTitle ? ' · ' + String(r.jobTitle) : ''}
                      {r.version ? ' · v' + String(r.version) : ''}
                    </p>
                  </div>
                  <div className="action-group">
                    <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(r.id))}>Open</button>
                    {can(user, 'hr.contracts.view') && (
                      <>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openContractDoc(r, 'print')}>{docBusy === String(r.id) + 'print' ? 'Printing…' : 'Print'}</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openContractDoc(r, 'pdf')}>{docBusy === String(r.id) + 'pdf' ? 'Saving…' : 'PDF'}</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {tab === 'leave' && (
        <div className="desk-panel stack">
          {can(user, 'hr.leave.create') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>⛱</span><div><h3>Request leave</h3><p>Annual leave posts to the approval queue.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field"><label>From</label><input type="date" value={leaveStart} onChange={(ev) => setLeaveStart(ev.target.value)} /></div>
                <div className="field"><label>To</label><input type="date" value={leaveEnd} onChange={(ev) => setLeaveEnd(ev.target.value)} /></div>
              </div>
              <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || !leaveStart || !leaveEnd} onClick={() => act('/api/ops/hr/leave', { employeeId: id, startDate: leaveStart, endDate: leaveEnd, leaveType: 'ANNUAL' }, 'Leave submitted')}>Submit leave</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Leave history</h3></div>
            {leaveRows.length === 0 ? (
              <div className="card-pad"><EmptyState icon="⛱" title="No leave recorded" hint="Approved and pending requests appear here." /></div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Type</th><th>From</th><th>To</th><th>Status</th></tr></thead>
                  <tbody>
                    {leaveRows.map((r) => (
                      <tr key={String(r.id)}>
                        <td><Badge value={r.leaveType} /></td>
                        <td>{shortDate(r.startDate)}</td>
                        <td>{shortDate(r.endDate)}</td>
                        <td><Badge value={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
      {tab === 'pay' && (
        <div className="desk-panel stack">
          {can(user, 'hr.loans.create') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>▣</span><div><h3>Staff loan</h3><p>Monthly deduction on the next payroll.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field"><label>Amount</label><input inputMode="decimal" value={loanAmt} onChange={(ev) => setLoanAmt(ev.target.value)} /></div>
                <div className="field"><label>Monthly deduction</label><input inputMode="decimal" value={loanDed} onChange={(ev) => setLoanDed(ev.target.value)} /></div>
              </div>
              <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={() => act(`/api/ops/hr/employees/${id}/loans`, { amount: Number(loanAmt), monthlyDeduction: Number(loanDed) }, 'Loan booked')}>Book loan</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Payslips</h3></div>
            {slips.length === 0 ? (
              <div className="card-pad"><EmptyState icon="₴" title="No slips yet" hint="Slips appear after a payroll run is calculated. Print or save PDF from each slip." /></div>
            ) : (
              <div className="doc-card-list">
                {slips.map((r) => (
                  <article key={String(r.id)} className="doc-card">
                    <div className="doc-card-main">
                      <div className="doc-card-top">
                        <span className="cell-mono">{String(r.payslipNo ?? '-')}</span>
                        {r.status ? <Badge value={r.status} /> : null}
                      </div>
                      <p className="doc-card-meta">
                        {String(r.payrollNo ?? 'Payroll')}
                        {r.periodStart ? ' · ' + shortDate(r.periodStart) + ' to ' + shortDate(r.periodEnd) : ''}
                        {' · Gross ' + fmtMoney(r.grossPay) + ' · Net ' + fmtMoney(r.netPay)}
                      </p>
                    </div>
                    {can(user, 'hr.payslips.view') && (
                      <div className="action-group">
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(r, 'print')}>{docBusy === 'slip-' + String(r.id) + 'print' ? 'Printing…' : 'Print'}</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(r, 'pdf')}>{docBusy === 'slip-' + String(r.id) + 'pdf' ? 'Saving…' : 'PDF'}</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {tab === 'career' && (
        <div className="desk-panel stack">
          {can(user, 'hr.employees.update') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>↕</span><div><h3>Record movement</h3><p>Transfer, promotion or secondment from an effective date.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field field-required"><label>Movement type</label>
                  <select value={movementType} onChange={(ev) => setMovementType(ev.target.value)}>
                    <option value="TRANSFER">Transfer</option>
                    <option value="PROMOTION">Promotion</option>
                    <option value="DEMOTION">Demotion</option>
                    <option value="ROTATION">Rotation</option>
                    <option value="SECONDMENT">Secondment</option>
                  </select>
                </div>
                <div className="field field-required"><label>New position</label>
                  <select value={movementPositionId} onChange={(ev) => setMovementPositionId(ev.target.value)}>
                    <option value="">Select position</option>
                    {positions.map((p) => (
                      <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.title)}</option>
                    ))}
                  </select>
                </div>
                <div className="field field-required"><label>Effective date</label><input type="date" value={movementEffective} onChange={(ev) => setMovementEffective(ev.target.value)} /></div>
                <div className="field"><label>New salary (UGX)</label><input inputMode="decimal" value={movementSalary} onChange={(ev) => setMovementSalary(ev.target.value)} placeholder="Blank keeps current salary" /></div>
                <div className="field"><label>Reason</label><input value={movementReason} onChange={(ev) => setMovementReason(ev.target.value)} placeholder="e.g. Promoted to Production Supervisor" /></div>
              </div>
              <button className="btn" style={{ marginTop: 10 }} disabled={busy || !movementPositionId || !movementEffective} onClick={recordMovement}>Record movement</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Lifecycle</h3><span className="muted">{fmtNum(timeline.length)} events</span></div>
            {timeline.length === 0 ? (
              <div className="card-pad"><EmptyState icon="●" title="No events yet" hint="Hire, contract, leave and payroll events collect here." /></div>
            ) : (
              <ul className="time-rail">
                {timeline.slice().sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)).map((ev) => (
                  <li key={`${String(ev.eventType)}-${String(ev.entityId)}-${String(ev.date)}`}>
                    <span className="time-dot" aria-hidden />
                    <span className="time-date">{shortDate(ev.date)}</span>
                    <div className="time-body">
                      <strong>{String(ev.title)}</strong>
                      <span>{String(ev.entityType).replace(/_/g, ' ')}{ev.entityCode ? ' · ' + String(ev.entityCode) : ''}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          reasonLabel={null}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); if (c) c.run(); }}
        />
      )}
    </div>
  );
}
