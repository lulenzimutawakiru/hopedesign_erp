import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { useCompanyProfile } from '../company';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { ConfirmDialog, Drawer, EmptyState, Skeleton } from '../components/os';
import { Rec, labelize, s, tileStyle } from './assetsShared';
import DatabaseCenter from './DatabaseCenter';

const USER_STATUSES = ['ACTIVE', 'INVITED', 'PENDING_ACTIVATION', 'INACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED', 'TERMINATED'];

function AdminHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="adm">Administration</p>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ maxWidth: 860 }}>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

function KpiTile({ label, value, sub, icon, accent, tint, href }: {
  label: string; value: unknown; sub: string; icon: string; accent: string; tint: string; href: string;
}) {
  return (
    <button className="kpi-tile" style={tileStyle(accent, tint)} onClick={() => navigate(href)}>
      <span className="kpi-tile-icon" aria-hidden>{icon}</span>
      <span className="kpi-tile-body">
        <span className="kpi-tile-label">{label}</span>
        <span className="kpi-tile-value">{typeof value === 'string' && !Number.isFinite(Number(value)) ? value : fmtNum(value)}</span>
        <span className="kpi-tile-sub">{sub}</span>
      </span>
    </button>
  );
}

export default function AdminFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return <Dashboard />;
  switch (parts[1]) {
    case 'users': return <Users />;
    case 'roles': return <Roles />;
    case 'policies': return <Policies />;
    case 'sod': return <Sod />;
    case 'security': return <Security />;
    case 'sessions': return <Sessions />;
    case 'audit': return <Audit />;
    case 'settings': return <SettingsPage />;
    case 'features': return <Features />;
    case 'health': return <Health />;
    case 'backups': return <Backups />;
    case 'database': return <DatabaseCenter />;
    default: return <Dashboard />;
  }
}

function Dashboard() {
  const { user } = useAuth();
  const company = useCompanyProfile();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/admin/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Administration dashboard failed'));
  }, []);
  if (error) {
    return (
      <div className="page">
        <AdminHeader title="Administration dashboard" />
        <ErrorBanner error={error} />
      </div>
    );
  }
  if (!data) return <PageLoader label="Loading administration dashboard..." />;
  const u = (data.users ?? {}) as Rec;
  const sess = (data.sessions ?? {}) as Rec;
  const auditRows = Array.isArray(data.recentAudit) ? (data.recentAudit as Rec[]) : [];
  const cards = [
    { key: 'total', label: 'Total users', value: u.total, sub: 'All accounts', icon: 'U', accent: '#334155', tint: 'rgba(51,65,85,0.14)', href: '/admin/users' },
    { key: 'active', label: 'Active users', value: u.active, sub: 'Accounts in good standing', icon: 'A', accent: '#16a34a', tint: 'rgba(22,163,74,0.14)', href: '/admin/users?status=ACTIVE' },
    { key: 'locked', label: 'Locked accounts', value: u.locked, sub: 'Temporarily locked', icon: 'L', accent: '#dc2626', tint: 'rgba(220,38,38,0.14)', href: '/admin/users?status=LOCKED' },
    { key: 'mfa', label: 'MFA enrolled', value: u.mfaEnrolled, sub: 'Multi-factor protected', icon: 'M', accent: '#7c3aed', tint: 'rgba(124,58,237,0.14)', href: '/admin/users' },
    { key: 'sessions', label: 'Active sessions', value: sess.activeSessions, sub: 'Live logins', icon: 'S', accent: '#0891b2', tint: 'rgba(8,145,178,0.14)', href: '/admin/sessions' },
    { key: 'roles', label: 'Roles', value: data.roles, sub: 'Role definitions', icon: 'R', accent: '#ca8a04', tint: 'rgba(202,138,4,0.14)', href: '/admin/roles' },
    { key: 'policies', label: 'Active policies', value: data.activePolicies, sub: 'ABAC policy rules', icon: 'P', accent: '#4f46e5', tint: 'rgba(79,70,229,0.14)', href: '/admin/policies' },
    { key: 'sod', label: 'SoD conflicts', value: data.sodConflicts, sub: 'Segregation of duties', icon: 'C', accent: '#ea580c', tint: 'rgba(234,88,12,0.14)', href: '/admin/sod' },
    { key: 'failed', label: 'Failed logins 24h', value: data.failedLogins24h, sub: 'Authentication failures', icon: 'F', accent: '#b91c1c', tint: 'rgba(185,28,28,0.14)', href: '/admin/security' },
  ];
  return (
    <div className="page">
      <AdminHeader
        title="Administration control plane"
        sub={`Identity, access, governance and security for the ${company.name} ERP. Every action here is enforced by RBAC, ABAC, organizational scope and audit.`}
        actions={
          <>
            {can(user, 'admin.users.create') && <button className="btn btn-primary" onClick={() => navigate('/admin/users?new=1')}>Add user</button>}
            {can(user, 'admin.sod.view') && <button className="btn" onClick={() => navigate('/admin/sod')}>Review SoD</button>}
          </>
        }
      />
      <div className="kpi-grid--tiles">
        {cards.map(({ key, ...rest }) => <KpiTile key={key} {...rest} />)}
      </div>
      <section className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>Recent audit activity</h3></div>
        {auditRows.length === 0 ? <p className="muted">No audit events yet.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Record</th></tr>
              </thead>
              <tbody>
                {auditRows.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{fmtDate(r.createdAt)}</td>
                    <td>{s(r.actor)}</td>
                    <td>{labelize(r.action)}</td>
                    <td>{labelize(r.resource)}</td>
                    <td className="td-cell-mono">{s(r.recordCode)}</td>
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

function Users() {
  const { user } = useAuth();
  const q = useHashQuery();
  const status = q.get('status') ?? '';
  const search = q.get('search') ?? '';
  const page = Math.max(1, Number(q.get('page')) || 1);
  const [searchInput, setSearchInput] = useState(search);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(Boolean(q.get('new')));
  const [detailId, setDetailId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const pageSize = 25;

  useEffect(() => { setSearchInput(search); }, [search]);

  const setListQuery = (next: { status?: string; search?: string; page?: number; newUser?: boolean }) => {
    const st = next.status !== undefined ? next.status : status;
    const qsearch = next.search !== undefined ? next.search : search;
    const pg = next.page !== undefined ? next.page : page;
    navigate('/admin/users', {
      replace: true,
      query: {
        status: st || undefined,
        search: qsearch || undefined,
        page: pg > 1 ? pg : undefined,
        new: next.newUser ? 1 : undefined,
      },
    });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    api<{ data: { data: Rec[]; pagination: { total: number } } }>(`/api/admin/users?${params.toString()}`)
      .then((r) => {
        if (!alive) return;
        const list = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? (r.data as unknown as Rec[]) : [];
        setRows(list);
        setTotal(Number(r.data?.pagination?.total ?? list.length) || 0);
      })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'Users failed'); setRows([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, search, status, reload]);

  const submitSearch = (ev: React.FormEvent) => {
    ev.preventDefault();
    setListQuery({ search: searchInput.trim(), page: 1 });
  };

  const pickStatus = (st: string) => {
    setListQuery({ status: status === st ? '' : st, page: 1 });
  };

  return (
    <div className="page">
      <AdminHeader
        title="Users and identity"
        sub="Provision, secure and govern every ERP account. Status changes, role assignments and scope updates are written to the audit trail."
        actions={can(user, 'admin.users.create') ? <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add user</button> : undefined}
      />
      <div className="toolbar">
        <form onSubmit={submitSearch} style={{ display: 'flex', gap: 8, flex: 1 }}>
          <input
            className="search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, email, username, employee no..."
            aria-label="Search users"
          />
          <button type="submit" className="btn btn-sm">Search</button>
        </form>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={!status ? 'chip chip-on' : 'chip'} onClick={() => setListQuery({ status: '', page: 1 })}>All</button>
        {USER_STATUSES.map((st) => (
          <button key={st} className={st === status ? 'chip chip-on' : 'chip'} onClick={() => pickStatus(st)}>{labelize(st)}</button>
        ))}
        <span className="muted" style={{ marginLeft: 8 }}>{fmtNum(total)} account{total === 1 ? '' : 's'}{status ? ` · ${labelize(status)}` : ''}</span>
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>User</th><th>Employee</th><th>Branch</th><th>Roles</th><th>MFA</th><th>Status</th><th>Last login</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)} className="row-link" onClick={() => setDetailId(Number(r.id))}>
                    <td>
                      <strong>{s(r.firstName)} {s(r.lastName)}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>{s(r.email)}</div>
                    </td>
                    <td>
                      {s(r.employeeNo)
                        ? (
                          <span>
                            <span className="cell-mono">{s(r.employeeNo)}</span>
                            <div className="muted" style={{ fontSize: 12 }}>{s(r.employeeFirstName)} {s(r.employeeLastName)}</div>
                          </span>
                        )
                        : <span className="muted">Not linked</span>}
                    </td>
                    <td>{s(r.branchName) || s(r.companyName) || '-'}</td>
                    <td>{fmtNum(r.roleCount)}</td>
                    <td>{r.mfaEnabled ? <span className="badge badge-green"><span className="badge-icon" aria-hidden>+</span>Yes</span> : <span className="muted">No</span>}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="td-cell-mono">{r.lastLoginAt ? fmtDate(r.lastLoginAt) : '-'}</td>
                    <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setDetailId(Number(r.id)); }}>View</button></td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8}><EmptyState title="No users found" body={status ? `No ${labelize(status)} accounts. Choose All to see every ERP user.` : 'Adjust the search or add a new user.'} /></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={pageSize} total={total} onPage={(p) => setListQuery({ page: p })} />
        </>
      )}
      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            setListQuery({ status: '', search: '', page: 1 });
            setReload((x) => x + 1);
          }}
        />
      )}
      {detailId !== null && (
        <UserDrawer
          id={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => setReload((x) => x + 1)}
        />
      )}
    </div>
  );
}

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { user: me } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [invite, setInvite] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [employeeQ, setEmployeeQ] = useState('');
  const [employeeHits, setEmployeeHits] = useState<Rec[]>([]);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [roles, setRoles] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Rec | null>(null);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments').then((r) => setDepts(r.data ?? [])).catch(() => undefined);
    api<{ data: { data: Rec[] } }>('/api/admin/roles?pageSize=100').then((r) => setRoles(r.data?.data ?? [])).catch(() => undefined);
  }, []);

  const toggleRole = (id: string) => {
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const save = async () => {
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('First name, last name and email are required');
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { user: Rec; tempPassword: string | null; invitationToken?: string | null } }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          username: username.trim() || undefined,
          job_title: jobTitle.trim() || undefined,
          phone: phone.trim() || undefined,
          department_id: departmentId ? Number(departmentId) : undefined,
          company_id: me?.company_id ?? me?.default_company_id ?? undefined,
          employee_id: employeeId ? Number(employeeId) : undefined,
          role_ids: roleIds.map(Number),
          invite,
        }),
      });
      setResult(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create user');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const u = (result.user ?? {}) as Rec;
    const done = () => { onCreated?.(); onClose(); };
    const inviteLink = result.invitationToken
      ? `${location.origin}${location.pathname}#/invite?token=${encodeURIComponent(String(result.invitationToken))}`
      : '';
    return (
      <Modal title="User created" onClose={done}>
        <div className="stack">
          <p className="muted">Account <strong>{s(u.email)}</strong> is now <Badge value={u.status} />.</p>
          {result.tempPassword ? (
            <>
              <div className="notice-banner">Temporary password shown once below. The user must change it at first login.</div>
              <div className="td-cell-mono" style={{ fontSize: 18, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8 }}>{s(result.tempPassword)}</div>
            </>
          ) : result.invitationToken ? (
            <>
              <div className="notice-banner">Invitation link shown once below. Share it with the user - it expires in 7 days.</div>
              <div className="td-cell-mono" style={{ fontSize: 13, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8, wordBreak: 'break-all' }}>
                {inviteLink}
              </div>
              <button className="btn" onClick={() => { void navigator.clipboard?.writeText(inviteLink); }}>Copy link</button>
            </>
          ) : (
            <div className="notice-banner">Account created.</div>
          )}
          <div className="btn-row"><button className="btn btn-primary" onClick={done}>Done</button></div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add user" onClose={onClose} wide>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="grid-2">
          <div className="field"><label className="field-required">First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="field"><label className="field-required">Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
        </div>
        <div className="grid-2">
          <div className="field"><label className="field-required">Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Defaults to email prefix" /></div>
        </div>
        <div className="grid-2">
          <div className="field"><label>Job title</label><input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Department</label>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">None selected</option>
            {depts.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.code)} - {s(d.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Link HR employee</label>
          {employeeId ? (
            <p className="muted">
              {s(employeeHits.find((e) => s(e.id) === employeeId)?.employeeNo) || employeeId}
              {' · '}
              {s(employeeHits.find((e) => s(e.id) === employeeId)?.firstName)} {s(employeeHits.find((e) => s(e.id) === employeeId)?.lastName)}
              {' '}<button type="button" className="btn btn-sm" onClick={() => { setEmployeeId(''); setEmployeeHits([]); setEmployeeQ(''); }}>Clear</button>
            </p>
          ) : (
            <div className="toolbar">
              <input
                className="search-input"
                value={employeeQ}
                onChange={(e) => setEmployeeQ(e.target.value)}
                placeholder="Search employee no, name or email"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const q = employeeQ.trim() || email.trim();
                  if (!q) { setEmployeeHits([]); return; }
                  api<{ data: Rec[] }>(`/api/admin/employees?unlinked=1&q=${encodeURIComponent(q)}`)
                    .then((r) => setEmployeeHits(r.data ?? []))
                    .catch(() => undefined);
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const q = employeeQ.trim() || email.trim();
                  if (!q) { setEmployeeHits([]); return; }
                  api<{ data: Rec[] }>(`/api/admin/employees?unlinked=1&q=${encodeURIComponent(q)}`)
                    .then((r) => setEmployeeHits(r.data ?? []))
                    .catch(() => undefined);
                }}
              >Search</button>
            </div>
          )}
          {!employeeId && employeeHits.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data">
                <tbody>
                  {employeeHits.map((emp) => (
                    <tr key={s(emp.id)}>
                      <td className="cell-mono">{s(emp.employeeNo)}</td>
                      <td>{s(emp.firstName)} {s(emp.lastName)}</td>
                      <td>{s(emp.position) || '-'}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setEmployeeId(s(emp.id))}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="field">
          <label>Roles</label>
          <div className="chips">
            {roles.map((r) => (
              <button key={s(r.id)} type="button" className={roleIds.includes(s(r.id)) ? 'chip chip-on' : 'chip'} onClick={() => toggleRole(s(r.id))}>
                {s(r.name)}
              </button>
            ))}
          </div>
        </div>
        <label className="filter-check">
          <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
          Send invitation link instead (user sets their own password)
        </label>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Creating...' : 'Create user'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  </Modal>
  );
}

function EmployeeLinkPanel({
  userId, employee, matches, canEdit, onChanged,
}: { userId: number; employee: Rec | null; matches: Rec[]; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    if (!q.trim()) { setHits([]); return; }
    try {
      const r = await api<{ data: Rec[] }>(`/api/admin/employees?unlinked=1&q=${encodeURIComponent(q.trim())}`);
      setHits(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    }
  };
  const link = async (employeeId: number) => {
    setBusy(true); setError('');
    try {
      await api(`/api/admin/users/${userId}/link-employee`, { method: 'POST', body: JSON.stringify({ employeeId }) });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link');
    } finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/admin/users/${userId}/unlink-employee`, { method: 'POST', body: '{}' });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlink');
    } finally { setBusy(false); }
  };
  if (employee && employee.id) {
    return (
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <p>
          <strong>{s(employee.firstName)} {s(employee.lastName)}</strong>
          {' · '}<span className="cell-mono">{s(employee.employeeNo)}</span>
          {employee.position ? ` · ${s(employee.position)}` : ''}
        </p>
        <p className="muted"><Badge value={employee.status} /> {s(employee.departmentName) || ''} {s(employee.email) ? `· ${s(employee.email)}` : ''}</p>
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => navigate(`/people/employees/${employee.id}`)}>Open HR file</button>
          {canEdit && <button className="btn btn-sm" disabled={busy} onClick={() => void unlink()}>Unlink</button>}
        </div>
      </div>
    );
  }
  const options = hits.length ? hits : matches;
  return (
    <div className="stack">
      {error && <ErrorBanner error={error} />}
      <p className="muted">This login is not linked to an HR employee file. Payroll, leave and contracts stay on the employee record.</p>
      {canEdit && (
        <div className="toolbar">
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee no, name or email" onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
          <button className="btn btn-sm" onClick={() => void search()}>Search</button>
        </div>
      )}
      {options.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {options.map((row) => (
                <tr key={s(row.id)}>
                  <td className="cell-mono">{s(row.employeeNo)}</td>
                  <td>{s(row.firstName)} {s(row.lastName)}</td>
                  <td>{s(row.position) || '-'}</td>
                  <td>
                    {canEdit && <button className="btn btn-sm" disabled={busy || row.userId != null} onClick={() => void link(Number(row.id))}>{row.userId != null ? 'Linked' : 'Link'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { user: me } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<{ action: string; title: string; body: string } | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [resetToken, setResetToken] = useState<Rec | null>(null);
  const [roleOptions, setRoleOptions] = useState<Rec[]>([]);
  const [addRoleId, setAddRoleId] = useState('');

  const load = () => {
    api<{ data: Rec }>(`/api/admin/users/${id}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'User detail failed'));
  };
  useEffect(() => {
    load();
    api<{ data: { data: Rec[] } }>('/api/admin/roles?pageSize=100').then((r) => setRoleOptions(r.data?.data ?? [])).catch(() => undefined);
  }, [id]);

  const u = (data?.user ?? {}) as Rec;
  const roles = Array.isArray(data?.roles) ? (data.roles as Rec[]) : [];
  const history = Array.isArray(data?.history) ? (data.history as Rec[]) : [];
  const sessions = Array.isArray(data?.sessions) ? (data.sessions as Rec[]) : [];

  const runAction = async (path: string, label: string, reason?: string) => {
    setBusy(label); setError(''); setNotice('');
    try {
      await api(`/api/admin/users/${id}${path}`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
      setNotice(`${label} completed`);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy('');
    }
  };

  const assignRole = async () => {
    if (!addRoleId) return;
    setBusy('assign'); setError(''); setNotice('');
    try {
      await api(`/api/admin/users/${id}/roles`, { method: 'POST', body: JSON.stringify({ role_ids: [Number(addRoleId)] }) });
      setAddRoleId(''); setNotice('Role assigned'); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Role assignment failed');
    } finally {
      setBusy('');
    }
  };

  const removeRole = async (roleId: number) => {
    setBusy('remove'); setError(''); setNotice('');
    try {
      await api(`/api/admin/users/${id}/roles/${roleId}`, { method: 'DELETE' });
      setNotice('Role removed'); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Role removal failed');
    } finally {
      setBusy('');
    }
  };

  const revokeSession = async (sessionId: number) => {
    setBusy('session'); setError(''); setNotice('');
    try {
      await api(`/api/admin/sessions/${sessionId}/revoke`, { method: 'POST', body: JSON.stringify({}) });
      setNotice('Session revoked'); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Session revoke failed');
    } finally {
      setBusy('');
    }
  };

  const doReset = async () => {
    setBusy('reset'); setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/admin/users/${id}/reset_password`, { method: 'POST', body: JSON.stringify({}) });
      setResetToken(r.data); setShowReset(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Password reset failed');
    } finally {
      setBusy('');
    }
  };

  if (!data) return <Drawer title="User profile" onClose={onClose}><Skeleton rows={10} /></Drawer>;

  const status = s(u.status);
  const canActivate = can(me, 'admin.users.activate');
  const canSuspend = can(me, 'admin.users.suspend');
  const canReset = can(me, 'admin.users.reset_password');

  return (
    <Drawer
      title={`${s(u.firstName)} ${s(u.lastName)}`}
      onClose={onClose}
      footer={
        <div className="btn-row">
          {canSuspend && status === 'ACTIVE' && (
            <button className="btn" disabled={!!busy} onClick={() => setConfirm({ action: 'suspend', title: 'Suspend account', body: `Suspend ${s(u.email)}? The user will be signed out and blocked from logging in.` })}>Suspend</button>
          )}
          {canActivate && status !== 'ACTIVE' && status !== 'TERMINATED' && (
            <button className="btn btn-primary" disabled={!!busy} onClick={() => setConfirm({ action: 'activate', title: 'Activate account', body: `Activate ${s(u.email)}? The user will be able to sign in.` })}>Activate</button>
          )}
          {canActivate && status === 'LOCKED' && (
            <button className="btn" disabled={!!busy} onClick={() => setConfirm({ action: 'unlock', title: 'Unlock account', body: `Unlock ${s(u.email)} and clear the lockout?` })}>Unlock</button>
          )}
          {canReset && <button className="btn" disabled={!!busy} onClick={() => setShowReset(true)}>Reset password</button>}
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {notice && <div className="notice-banner">{notice}</div>}
        <div className="def-list">
          <div><dt>Email</dt><dd>{s(u.email)}</dd></div>
          <div><dt>Username</dt><dd>{s(u.username) || '-'}</dd></div>
          <div><dt>Employee</dt><dd>{s(u.employeeNo) ? `${s(u.employeeNo)} · ${s(u.employeeFirstName)} ${s(u.employeeLastName)}` : 'Not linked'}</dd></div>
          <div><dt>Job title</dt><dd>{s(u.jobTitle) || '-'}</dd></div>
          <div><dt>Department</dt><dd>{s(u.departmentName) || '-'}</dd></div>
          <div><dt>Branch</dt><dd>{s(u.branchName) || '-'}</dd></div>
          <div><dt>Company</dt><dd>{s(u.companyName) || '-'}</dd></div>
          <div><dt>Status</dt><dd><Badge value={u.status} /></dd></div>
          <div><dt>MFA</dt><dd>{u.mfaEnabled ? 'Enrolled' : 'Not enrolled'}</dd></div>
          <div><dt>Last login</dt><dd className="td-cell-mono">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : '-'}</dd></div>
          <div><dt>Created</dt><dd className="td-cell-mono">{u.createdAt ? fmtDate(u.createdAt) : '-'}</dd></div>
        </div>

        <section className="def-sec">
          <div className="def-sec-head"><div><h3>HR employee file</h3></div></div>
          <EmployeeLinkPanel
            userId={id}
            employee={(data?.employee ?? null) as Rec | null}
            matches={Array.isArray(data?.employeeMatches) ? (data.employeeMatches as Rec[]) : []}
            canEdit={can(me, 'admin.users.update')}
            onChanged={() => { load(); onChanged?.(); }}
          />
        </section>

        <section className="def-sec">
          <div className="def-sec-head"><div><h3>Roles</h3></div></div>
          {roles.length === 0 ? <p className="muted">No roles assigned.</p> : (
            <div className="chips">
              {roles.map((r) => (
                <span key={s(r.id)} className="chip">
                  {s(r.name)}
                  {can(me, 'admin.users.assign_roles') && (
                    <button type="button" className="chip-x" aria-label={`Remove ${s(r.name)}`} onClick={() => removeRole(Number(r.id))}>x</button>
                  )}
                </span>
              ))}
            </div>
          )}
          {can(me, 'admin.users.assign_roles') && (
            <div className="toolbar" style={{ marginTop: 8 }}>
              <select value={addRoleId} onChange={(e) => setAddRoleId(e.target.value)} style={{ flex: 1 }}>
                <option value="">Assign a role...</option>
                {roleOptions.filter((r) => !roles.some((x) => Number(x.id) === Number(r.id))).map((r) => (
                  <option key={s(r.id)} value={s(r.id)}>{s(r.name)}</option>
                ))}
              </select>
              <button className="btn btn-sm" disabled={!addRoleId || busy === 'assign'} onClick={assignRole}>Assign</button>
            </div>
          )}
        </section>

        <section className="def-sec">
          <div className="def-sec-head"><div><h3>Sessions</h3></div></div>
          {sessions.length === 0 ? <p className="muted">No sessions recorded.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Created</th><th>IP</th><th>Device</th><th>MFA</th><th></th></tr></thead>
                <tbody>
                  {sessions.map((sess) => (
                    <tr key={s(sess.id)}>
                      <td className="td-cell-mono">{sess.createdAt ? fmtDate(sess.createdAt) : '-'}</td>
                      <td className="td-cell-mono">{s(sess.ip)}</td>
                      <td>{s(sess.device) || '-'}</td>
                      <td>{sess.mfaVerifiedAt ? 'Yes' : 'No'}</td>
                      <td>
                        {!sess.revokedAt && can(me, 'admin.sessions.revoke') && (
                          <button className="btn btn-sm" disabled={busy === 'session'} onClick={() => revokeSession(Number(sess.id))}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="def-sec">
          <div className="def-sec-head"><div><h3>Status history</h3></div></div>
          {history.length === 0 ? <p className="muted">No status changes yet.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Change</th><th>Reason</th><th>By</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={s(h.id)}>
                      <td className="td-cell-mono">{h.createdAt ? fmtDate(h.createdAt) : '-'}</td>
                      <td>{labelize(h.fromStatus)} {'\u2192'} {labelize(h.toStatus)}</td>
                      <td>{s(h.reason) || '-'}</td>
                      <td>{s(h.changedByName) || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {showReset && (
        <Modal title="Reset password" onClose={() => setShowReset(false)}>
          <div className="stack">
            <p className="muted">Generate a one-time reset token for <strong>{s(u.email)}</strong>. The token expires after 24 hours and is shown only once.</p>
            {resetToken && (
              <>
                <div className="notice-banner">Token shown once below. Copy it now.</div>
                <div className="td-cell-mono" style={{ padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8 }}>{s(resetToken.token)}</div>
              </>
            )}
            <div className="btn-row">
              {!resetToken && <button className="btn btn-primary" disabled={busy === 'reset'} onClick={doReset}>Generate token</button>}
              <button className="btn" onClick={() => setShowReset(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.action === 'activate' ? 'Activate' : confirm.action === 'unlock' ? 'Unlock' : 'Confirm'}
          danger={confirm.action !== 'activate' && confirm.action !== 'unlock'}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { setConfirm(null); runAction(`/${confirm.action}`, labelize(confirm.action), reason); }}
        />
      )}
    </Drawer>
  );
}

function Roles() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editRole, setEditRole] = useState<Rec | null>(null);
  const [permsRole, setPermsRole] = useState<Rec | null>(null);

  const load = () => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ pageSize: '200' });
    if (search) params.set('search', search);
    api<{ data: { data: Rec[] } }>(`/api/admin/roles?${params.toString()}`)
      .then((r) => setRows(r.data?.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Roles failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [search]);

  const filtered = rows.filter((r) => !search || s(r.name).toLowerCase().includes(search.toLowerCase()) || s(r.code).toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="page">
      <AdminHeader
        title="Roles and permissions"
        sub="Define enterprise roles, assign granular permissions and control what each role can do. Roles are stored in the database and enforced by the backend."
        actions={can(user, 'admin.roles.create') ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create role</button> : undefined}
      />
      <div className="toolbar">
        <input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search roles..." aria-label="Search roles" style={{ maxWidth: 420 }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>System</th><th>Company</th><th>Permissions</th><th>Users</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={s(r.id)}>
                  <td className="td-cell-mono">{s(r.code)}</td>
                  <td>
                    <strong>{s(r.name)}</strong>
                    {s(r.description) && <div className="muted" style={{ fontSize: 12 }}>{s(r.description)}</div>}
                  </td>
                  <td>{r.isSystem ? <Badge value="SYSTEM" /> : <span className="muted">No</span>}</td>
                  <td>{s(r.companyName) || 'All companies'}</td>
                  <td>{fmtNum(r.permissionCount)}</td>
                  <td>{fmtNum(r.userCount)}</td>
                  <td>
                    <div className="btn-row" style={{ gap: 6 }}>
                      {can(user, 'admin.permissions.assign') && (
                        <button className="btn btn-sm" onClick={() => setPermsRole(r)}>Permissions</button>
                      )}
                      {can(user, 'admin.roles.update') && (
                        <button className="btn btn-sm" onClick={() => setEditRole(r)}>Edit</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7}><EmptyState title="No roles found" body="Create a role to start assigning permissions." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showCreate && <RoleModal onClose={() => setShowCreate(false)} onSaved={load} />}
      {editRole && <RoleModal role={editRole} onClose={() => setEditRole(null)} onSaved={load} />}
      {permsRole && <RolePerms role={permsRole} onClose={() => setPermsRole(null)} />}
    </div>
  );
}

function RoleModal({ role, onClose, onSaved }: { role?: Rec; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(role ? s(role.code) : '');
  const [name, setName] = useState(role ? s(role.name) : '');
  const [description, setDescription] = useState(role ? s(role.description) : '');
  const [companyId, setCompanyId] = useState(role && role.companyId ? s(role.companyId) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) { setError('Role name is required'); return; }
    setBusy(true); setError('');
    try {
      if (role) {
        await api(`/api/admin/roles/${s(role.id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), description: description.trim() }) });
      } else {
        if (!code.trim()) { setError('Role code is required'); return; }
        await api('/api/admin/roles', {
          method: 'POST',
          body: JSON.stringify({
            code: code.trim(),
            name: name.trim(),
            description: description.trim() || undefined,
            company_id: companyId ? Number(companyId) : undefined,
          }),
        });
      }
      onSaved(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={role ? 'Edit role' : 'Create role'} onClose={onClose}>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {!role && (
          <div className="field">
            <label className="field-required">Code</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. finance_manager" />
          </div>
        )}
        <div className="field"><label className="field-required">Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        {!role && (
          <div className="field">
            <label>Company ID (optional)</label>
            <input type="number" value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="Leave blank for all companies" />
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

function RolePerms({ role, onClose }: { role: Rec; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Rec[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ data: Rec[] }>('/api/admin/permissions'),
      api<{ data: Rec[] }>(`/api/admin/roles/${s(role.id)}/permissions`),
    ])
      .then(([cat, rolePerms]) => {
        if (!alive) return;
        setCatalogue(cat.data ?? []);
        setSelected(new Set((rolePerms.data ?? []).map((p) => s(p.code))));
        setLoaded(true);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Permissions failed'); });
    return () => { alive = false; };
  }, [role.id]);

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/admin/roles/${s(role.id)}/permissions`, { method: 'POST', body: JSON.stringify({ permissions: [...selected] }) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, Rec[]>();
    for (const p of catalogue) {
      const key = `${s(p.module)}.${s(p.resource)}`;
      const arr = m.get(key) ?? [];
      arr.push(p);
      m.set(key, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalogue]);

  return (
    <Modal title={`Permissions - ${s(role.name)}`} onClose={onClose} wide>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {!loaded ? <Skeleton rows={8} /> : (
          <>
            <p className="muted">{selected.size} permissions selected. Saving replaces the full permission set for this role.</p>
            {groups.map(([key, perms]) => (
              <section key={key} className="def-sec">
                <div className="def-sec-head"><div><h3>{key}</h3></div></div>
                <div className="chips">
                  {perms.map((p) => {
                    const code = s(p.code);
                    const on = selected.has(code);
                    return (
                      <button key={code} type="button" className={on ? 'chip chip-on' : 'chip'} onClick={() => toggle(code)} title={s(p.description)}>
                        {s(p.action)}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save permissions'}</button>
              <button className="btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Policies() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editPolicy, setEditPolicy] = useState<Rec | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = () => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ pageSize: '100' });
    if (search) params.set('search', search);
    api<{ data: { data: Rec[] } }>(`/api/admin/policies?${params.toString()}`)
      .then((r) => setRows(r.data?.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Policies failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [search]);

  const toggleActive = async (p: Rec) => {
    setBusyId(Number(p.id)); setError('');
    try {
      await api(`/api/admin/policies/${s(p.id)}/activate`, { method: 'POST', body: JSON.stringify({ is_active: !p.isActive }) });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <AdminHeader
        title="Access policies"
        sub="ABAC policy rules evaluated by the authorization engine. Default behavior is DENY; policies add explicit ALLOW or DENY conditions."
        actions={can(user, 'admin.policies.create') ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create policy</button> : undefined}
      />
      <div className="toolbar">
        <input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search policies..." aria-label="Search policies" style={{ maxWidth: 420 }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Effect</th><th>Priority</th><th>Active</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={s(p.id)}>
                  <td className="td-cell-mono">{s(p.code)}</td>
                  <td>
                    <strong>{s(p.name)}</strong>
                    {s(p.description) && <div className="muted" style={{ fontSize: 12 }}>{s(p.description)}</div>}
                  </td>
                  <td>
                    {s(p.effect).toUpperCase() === 'ALLOW'
                      ? <span className="badge badge-green"><span className="badge-icon" aria-hidden>+</span>ALLOW</span>
                      : <span className="badge badge-red"><span className="badge-icon" aria-hidden>x</span>DENY</span>}
                  </td>
                  <td>{fmtNum(p.priority)}</td>
                  <td>{p.isActive ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />}</td>
                  <td className="td-cell-mono">{p.updatedAt ? fmtDate(p.updatedAt) : '-'}</td>
                  <td>
                    <div className="btn-row" style={{ gap: 6 }}>
                      {can(user, 'admin.policies.update') && (
                        <button className="btn btn-sm" onClick={() => setEditPolicy(p)}>Edit</button>
                      )}
                      {can(user, 'admin.policies.update') && (
                        <button className="btn btn-sm" disabled={busyId === Number(p.id)} onClick={() => toggleActive(p)}>
                          {p.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7}><EmptyState title="No policies" body="Create an ABAC policy rule to control access conditions." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showCreate && <PolicyModal onClose={() => setShowCreate(false)} onSaved={load} />}
      {editPolicy && <PolicyModal policy={editPolicy} onClose={() => setEditPolicy(null)} onSaved={load} />}
    </div>
  );
}

function PolicyModal({ policy, onClose, onSaved }: { policy?: Rec; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(policy ? s(policy.code) : '');
  const [name, setName] = useState(policy ? s(policy.name) : '');
  const [description, setDescription] = useState(policy ? s(policy.description) : '');
  const [effect, setEffect] = useState(policy ? String(s(policy.effect)).toUpperCase() : 'ALLOW');
  const [priority, setPriority] = useState(policy && policy.priority !== null && policy.priority !== undefined ? s(policy.priority) : '100');
  const [conditions, setConditions] = useState(policy
    ? JSON.stringify(
        (Array.isArray(policy.conditions) ? (policy.conditions as Rec[]) : []).map((c: Rec) => ({
          attributeType: c.attributeType,
          attribute: c.attribute,
          operator: c.operator,
          value: c.value,
        })),
        null,
        2
      )
    : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim() || (!policy && !code.trim())) { setError('Name and code are required'); return; }
    if (String(effect).toUpperCase() === 'DENY' && !conditions.trim()) {
      setError('A DENY policy with no conditions would block all access. Add at least one condition before saving.');
      return;
    }
    let cond: unknown[] = [];
    if (conditions.trim()) {
      try {
        const v = JSON.parse(conditions);
        if (!Array.isArray(v)) { setError('Conditions must be a JSON array'); return; }
        cond = v;
      } catch {
        setError('Conditions must be valid JSON (array of condition objects)');
        return;
      }
    }
    setBusy(true); setError('');
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || undefined,
        effect,
        priority: priority ? Number(priority) : 100,
      };
      if (conditions.trim()) body.conditions = cond;
      if (policy) {
        await api(`/api/admin/policies/${s(policy.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/api/admin/policies', { method: 'POST', body: JSON.stringify({ code: code.trim(), ...body }) });
      }
      onSaved(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={policy ? 'Edit policy' : 'Create policy'} onClose={onClose} wide>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {!policy && (
          <div className="field"><label className="field-required">Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. finance_high_value_approval" /></div>
        )}
        <div className="field"><label className="field-required">Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid-2">
          <div className="field">
            <label>Effect</label>
            <select value={effect} onChange={(e) => setEffect(e.target.value)}>
              <option value="ALLOW">ALLOW</option>
              <option value="DENY">DENY</option>
            </select>
          </div>
          <div className="field"><label>Priority</label><input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Conditions (JSON array)</label>
          <textarea
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            placeholder={'[{"attributeType":"SUBJECT","attribute":"department","operator":"EQUALS","value":"FINANCE"}]'}
            style={{ minHeight: 110, fontFamily: 'var(--font-mono)' }}
          />
          {String(effect).toUpperCase() === 'DENY' && (
            <p className="muted" style={{ fontSize: 12 }}>DENY requires at least one condition ? an unconditional DENY would block all access.</p>
          )}
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

function Sod() {
  const { user } = useAuth();
  const [rules, setRules] = useState<Rec[]>([]);
  const [conflicts, setConflicts] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      api<{ data: Rec[] }>('/api/admin/sod/rules'),
      api<{ data: Rec[] }>('/api/admin/sod/conflicts'),
    ])
      .then(([r, c]) => { setRules(r.data ?? []); setConflicts(c.data ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : 'SoD data failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="page">
      <AdminHeader
        title="Segregation of duties"
        sub="Detect and manage conflicts between incompatible permissions such as creating and approving the same transaction."
        actions={can(user, 'admin.sod.create') ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Add rule</button> : undefined}
      />
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <div className="stack">
          <section className="card card-pad">
            <div className="card-head"><h3>Conflict queue</h3></div>
            {conflicts.length === 0 ? <p className="muted">No active conflicts detected.</p> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>User</th><th>Rule</th><th>Conflict</th><th>Severity</th><th>Status</th><th>Detected</th></tr>
                  </thead>
                  <tbody>
                    {conflicts.map((c) => (
                      <tr key={s(c.id)}>
                        <td>
                          <strong>{s(c.userName)}</strong>
                          <div className="muted" style={{ fontSize: 12 }}>{s(c.userEmail)}</div>
                        </td>
                        <td>{s(c.ruleName)}</td>
                        <td>
                          <span className="muted">{s(c.primaryPermission)}</span> vs <span className="muted">{s(c.conflictingPermission)}</span>
                        </td>
                        <td>{s(c.severity) === 'CRITICAL' ? <Badge value="CRITICAL" /> : <Badge value={c.severity} />}</td>
                        <td>{s(c.status) === 'ACTIVE_CONFLICT' ? <Badge value="CRITICAL" /> : <Badge value={c.status} />}</td>
                        <td className="td-cell-mono">{c.detectedAt ? fmtDate(c.detectedAt) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="card card-pad">
            <div className="card-head"><h3>SoD rules</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Primary permission</th><th>Conflicting permission</th><th>Enforcement</th></tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={s(r.id)}>
                      <td className="td-cell-mono">{s(r.code)}</td>
                      <td>{s(r.name)}</td>
                      <td className="td-cell-mono">{s(r.primaryPermission)}</td>
                      <td className="td-cell-mono">{s(r.conflictingPermission)}</td>
                      <td>{s(r.enforcement) === 'hard' ? <Badge value="ACTIVE" /> : <Badge value="PENDING" />} {labelize(s(r.enforcement))}</td>
                    </tr>
                  ))}
                  {rules.length === 0 && (
                    <tr><td colSpan={5}><EmptyState title="No SoD rules" body="Add a rule to detect incompatible permission combinations." /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {showCreate && <SodRuleModal onClose={() => setShowCreate(false)} onSaved={load} />}
    </div>
  );
}

function SodRuleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [primary, setPrimary] = useState('');
  const [conflicting, setConflicting] = useState('');
  const [enforcement, setEnforcement] = useState('hard');
  const [perms, setPerms] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: Rec[] }>('/api/admin/permissions').then((r) => setPerms(r.data ?? [])).catch(() => undefined);
  }, []);

  const save = async () => {
    if (!code.trim() || !name.trim() || !primary || !conflicting) {
      setError('Code, name and both permissions are required');
      return;
    }
    setBusy(true); setError('');
    try {
      await api('/api/admin/sod/rules', {
        method: 'POST',
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          primary_permission: primary,
          conflicting_permission: conflicting,
          enforcement,
        }),
      });
      onSaved(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add SoD rule" onClose={onClose} wide>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="grid-2">
          <div className="field"><label className="field-required">Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. po_create_vs_approve" /></div>
          <div className="field"><label className="field-required">Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
        <div className="field"><label>Description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid-2">
          <div className="field">
            <label className="field-required">Primary permission</label>
            <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
              <option value="">Select...</option>
              {perms.map((p) => <option key={s(p.code)} value={s(p.code)}>{s(p.code)}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-required">Conflicting permission</label>
            <select value={conflicting} onChange={(e) => setConflicting(e.target.value)}>
              <option value="">Select...</option>
              {perms.map((p) => <option key={s(p.code)} value={s(p.code)}>{s(p.code)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Enforcement</label>
          <select value={enforcement} onChange={(e) => setEnforcement(e.target.value)}>
            <option value="hard">Hard (blocks conflicting assignment)</option>
            <option value="soft">Soft (flags only)</option>
          </select>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

const SEV_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function Security() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageSize = 25;

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (severity) params.set('severity', severity);
    api<{ data: { rows: Rec[]; pagination: { total: number } } }>(`/api/admin/security/events?${params.toString()}`)
      .then((r) => { if (alive) { setRows(r.data?.rows ?? []); setTotal(r.data?.pagination?.total ?? 0); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Security events failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, severity]);

  return (
    <div className="page">
      <AdminHeader
        title="Security center"
        sub="Login monitoring, suspicious activity and security events across the ERP."
      />
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={severity === '' ? 'chip chip-on' : 'chip'} onClick={() => { setSeverity(''); setPage(1); }}>All</button>
        {SEV_LEVELS.map((lv) => (
          <button key={lv} className={severity === lv ? 'chip chip-on' : 'chip'} onClick={() => { setSeverity(lv); setPage(1); }}>{lv}</button>
        ))}
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Severity</th><th>Event</th><th>User</th><th>IP</th><th>Device</th><th>Details</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{r.createdAt ? fmtDate(r.createdAt) : '-'}</td>
                    <td><Badge value={r.severity} /></td>
                    <td>{labelize(r.eventType)}</td>
                    <td>{s(r.userName) || s(r.userEmail) || '-'}</td>
                    <td className="td-cell-mono">{s(r.ip) || '-'}</td>
                    <td>{s(r.device) || '-'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s(r.details)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7}><EmptyState title="No security events" body="Events matching this severity filter will appear here." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function Sessions() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const pageSize = 25;

  const load = () => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (userId) params.set('user_id', userId);
    api<{ data: { rows: Rec[]; pagination: { total: number } } }>(`/api/admin/sessions?${params.toString()}`)
      .then((r) => { setRows(r.data?.rows ?? []); setTotal(r.data?.pagination?.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Sessions failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page, userId]);

  const revoke = async (id: number) => {
    setBusyId(id); setError('');
    try {
      await api(`/api/admin/sessions/${id}/revoke`, { method: 'POST', body: JSON.stringify({}) });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed');
    } finally {
      setBusyId(null);
    }
  };

  const revokeAll = async (reason: string) => {
    setError('');
    try {
      await api('/api/admin/sessions/revoke-all', { method: 'POST', body: JSON.stringify(userId ? { user_id: Number(userId), reason } : { reason }) });
      setConfirmAll(false); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke all failed');
    }
  };

  return (
    <div className="page">
      <AdminHeader
        title="Active sessions"
        sub="Monitor live sessions, force sign-out and enforce session policies."
        actions={can(user, 'admin.sessions.revoke') ? <button className="btn" onClick={() => setConfirmAll(true)}>Revoke all</button> : undefined}
      />
      <div className="toolbar">
        <input className="search-input" type="number" value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} placeholder="Filter by user ID" aria-label="Filter by user ID" style={{ maxWidth: 220 }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>User</th><th>Device</th><th>IP</th><th>User agent</th><th>MFA</th><th>Expires</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td>
                      <strong>{s(r.userName)}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>{s(r.userEmail)}</div>
                    </td>
                    <td>{s(r.device) || '-'}</td>
                    <td className="td-cell-mono">{s(r.ip) || '-'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s(r.userAgent)}</td>
                    <td>{r.mfaVerifiedAt ? 'Yes' : 'No'}</td>
                    <td className="td-cell-mono">{r.expiresAt ? fmtDate(r.expiresAt) : '-'}</td>
                    <td>{r.isActive ? <Badge value="ACTIVE" /> : <Badge value="REVOKED" />}</td>
                    <td>
                      {!!r.isActive && can(user, 'admin.sessions.revoke') && (
                        <button className="btn btn-sm" disabled={busyId === Number(r.id)} onClick={() => revoke(Number(r.id))}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8}><EmptyState title="No sessions" body="No sessions match the current filter." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
        </>
      )}
      {confirmAll && (
        <ConfirmDialog
          title="Revoke all sessions"
          body={userId ? `Revoke every session for user #${userId}?` : 'Revoke every active session in the tenant?'}
          confirmLabel="Revoke all"
          danger
          onCancel={() => setConfirmAll(false)}
          onConfirm={(reason) => revokeAll(reason)}
        />
      )}
    </div>
  );
}

type SettingType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'color' | 'url' | 'tel';
type Draft = string | boolean;

interface SettingValue {
  value: string | number | boolean | null;
  default: string | number | boolean | null;
  label: string;
  help: string | null;
  type: SettingType;
  options: string[] | null;
  secret: boolean;
  group: string | null;
  saved: boolean;
}

interface SettingCategory {
  category: string;
  label: string;
  blurb: string;
  meta: { updated_at: string | null; updated_by: string | null };
  settings: Record<string, SettingValue>;
}

const SETTING_TILE: Record<string, string> = {
  general: 'tile-mill',
  security: 'tile-moss',
  notifications: 'tile-brass',
  qr: 'tile-purple',
  quality: 'tile-amber',
  documents: 'tile-clay',
};

const isValidHexColor = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

const toDraft = (v: unknown): Draft => (v === null || v === undefined ? '' : (v as Draft));

const sameValue = (a: Draft, b: unknown) => {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return String(a ?? '') === String(b ?? '');
};

const fmtWhen = (v: string | null) => {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' });
};

function SettingsPage() {
  const { user } = useAuth();
  const editable = can(user, 'admin.settings.update');
  const [cats, setCats] = useState<SettingCategory[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, Draft>>>({});
  const [active, setActive] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const load = async () => {
    const r = await api<{ data: SettingCategory[] }>('/api/admin/settings');
    setCats(r.data);
    const d: Record<string, Record<string, Draft>> = {};
    for (const cat of r.data) {
      const row: Record<string, Draft> = {};
      for (const [key, s] of Object.entries(cat.settings)) row[key] = toDraft(s.value);
      d[cat.category] = row;
    }
    setDrafts(d);
    setActive((prev) => (r.data.some((c) => c.category === prev) ? prev : (r.data[0]?.category ?? '')));
  };

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load settings'));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const dirtyKeys = useMemo(() => {
    const n: Record<string, number> = {};
    if (!cats) return n;
    for (const cat of cats) {
      const d = drafts[cat.category] ?? {};
      n[cat.category] = Object.keys(cat.settings).filter((k) => !sameValue(d[k], cat.settings[k].value)).length;
    }
    return n;
  }, [cats, drafts]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !cats) return null;
    const out: { cat: SettingCategory; key: string; setting: SettingValue }[] = [];
    for (const cat of cats) {
      for (const [key, s] of Object.entries(cat.settings)) {
        const hay = [s.label, s.help ?? '', key, cat.label, String(s.value ?? '')].join(' ').toLowerCase();
        if (hay.includes(q)) out.push({ cat, key, setting: s });
      }
    }
    return out;
  }, [query, cats]);

  const setValue = (cat: string, key: string, v: Draft) => {
    setDrafts((prev) => ({ ...prev, [cat]: { ...(prev[cat] ?? {}), [key]: v } }));
  };

  const buildValues = (cat: SettingCategory) => {
    const d = drafts[cat.category] ?? {};
    const values: Record<string, string | number | boolean> = {};
    for (const [key, s] of Object.entries(cat.settings)) {
      if (s.type === 'boolean') values[key] = Boolean(d[key]);
      else if (s.type === 'number') values[key] = Number(d[key] === '' ? 0 : d[key]);
      else values[key] = String(d[key] ?? '');
    }
    return values;
  };

  const save = async (cat: SettingCategory) => {
    setError('');
    setBusy((b) => ({ ...b, [cat.category]: true }));
    try {
      const r = await api<{ data: SettingCategory }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ category: cat.category, values: buildValues(cat) }),
      });
      setCats((prev) => (prev ? prev.map((c) => (c.category === cat.category ? r.data : c)) : prev));
      const row: Record<string, Draft> = {};
      for (const [key, s] of Object.entries(r.data.settings)) row[key] = toDraft(s.value);
      setDrafts((prev) => ({ ...prev, [cat.category]: row }));
      setToast({ kind: 'ok', text: `${cat.label} settings saved` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save settings';
      setError(msg);
      setToast({ kind: 'err', text: msg });
    } finally {
      setBusy((b) => ({ ...b, [cat.category]: false }));
    }
  };

  if (!cats) return <PageLoader label="Loading system settings..." />;

  const activeCat = cats.find((c) => c.category === active) ?? cats[0];

  const renderRow = (cat: SettingCategory, key: string, s: SettingValue) => {
    const draft = drafts[cat.category]?.[key];
    const isDirty = !sameValue(draft, s.value);
    const offDefault = !sameValue(draft, s.default);
    const isSecret = s.secret && !revealed[key];
    return (
      <div className={isDirty ? 'setting-row dirty' : 'setting-row'} key={key}>
        <div className="setting-info">
          <div className="setting-label">
            <span>{s.label}</span>
            {s.secret && <span className="badge badge-purple">Secret</span>}
            {s.saved ? <span className="badge badge-green">Custom</span> : <span className="badge badge-neutral">Default</span>}
          </div>
          {s.help && <small className="muted">{s.help}</small>}
        </div>
        <div className="setting-control">
          {s.type === 'boolean' ? (
            <label className="check">
              <input
                type="checkbox"
                disabled={!editable}
                checked={Boolean(draft)}
                onChange={(e) => setValue(cat.category, key, e.target.checked)}
              />
              <span>{draft ? 'Enabled' : 'Disabled'}</span>
            </label>
          ) : s.type === 'select' ? (
            <select
              disabled={!editable}
              value={String(draft ?? '')}
              onChange={(e) => setValue(cat.category, key, e.target.value)}
            >
              {(s.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : s.type === 'textarea' ? (
            <textarea
              disabled={!editable}
              rows={2}
              value={String(draft ?? '')}
              onChange={(e) => setValue(cat.category, key, e.target.value)}
            />
          ) : s.type === 'color' ? (
            <span className="setting-color-wrap">
              <span
                className="setting-swatch"
                style={{ background: isValidHexColor(String(draft ?? '')) ? String(draft ?? '') : 'transparent' }}
                aria-hidden
              />
              <input
                type="color"
                disabled={!editable}
                value={isValidHexColor(String(draft ?? '')) ? String(draft ?? '') : '#1261A0'}
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
              <input
                type="text"
                className="setting-color-text"
                disabled={!editable}
                value={String(draft ?? '')}
                placeholder="#RRGGBB"
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
            </span>
          ) : (
            <span className="setting-input-wrap">
              <input
                type={
                  s.type === 'number' ? 'number' :
                  s.type === 'url' ? 'url' :
                  s.type === 'tel' ? 'tel' :
                  isSecret ? 'password' : 'text'
                }
                disabled={!editable}
                value={String(draft ?? '')}
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
              {s.secret && editable && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  {revealed[key] ? 'Hide' : 'Show'}
                </button>
              )}
            </span>
          )}
          {editable && offDefault && (
            <button
              type="button"
              className="btn btn-sm btn-ghost setting-reset"
              title="Reset this setting to its default"
              onClick={() => setValue(cat.category, key, toDraft(s.default))}
            >
              Reset default
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderCategoryCard = (cat: SettingCategory) => {
    const entries = Object.entries(cat.settings);
    type Section = { title: string | null; rows: [string, SettingValue][] };
    const sections: Section[] = [];
    const byTitle = new Map<string | null, Section>();
    for (const entry of entries) {
      const title = entry[1].group ?? null;
      let sec = byTitle.get(title);
      if (!sec) {
        sec = { title, rows: [] };
        byTitle.set(title, sec);
        sections.push(sec);
      }
      sec.rows.push(entry);
    }
    const hasSections = sections.some((s) => s.title !== null);
    return (
      <section className="card" key={cat.category}>
        <div className="card-head">
          <div>
            <h3>{cat.label}</h3>
            {cat.meta.updated_by && (
              <span className="muted" style={{ fontSize: 12 }}>
                Last changed by {cat.meta.updated_by} - {fmtWhen(cat.meta.updated_at)}
              </span>
            )}
          </div>
          <div className="head-actions">
            {dirtyKeys[cat.category] > 0 && <span className="badge badge-amber">{dirtyKeys[cat.category]} unsaved</span>}
            {editable && (
              <button
                className="btn btn-sm btn-primary"
                disabled={Boolean(busy[cat.category]) || dirtyKeys[cat.category] === 0}
                onClick={() => save(cat)}
              >
                {busy[cat.category] ? 'Saving...' : 'Save changes'}
              </button>
            )}
          </div>
        </div>
        <div className="card-pad">
          {hasSections ? (
            <div className="setting-sections">
              {sections.map((sec) => (
                <div className="setting-section" key={sec.title ?? '__default'}>
                  {sec.title && (
                    <div className="setting-section-head">
                      <h4>{sec.title}</h4>
                      <span className="badge badge-neutral">{sec.rows.length}</span>
                    </div>
                  )}
                  <div className="setting-list">
                    {sec.rows.map(([key, s]) => renderRow(cat, key, s))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="setting-list">
              {entries.map(([key, s]) => renderRow(cat, key, s))}
            </div>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="page">
      <AdminHeader
        title="System settings"
        sub="Identity, security, QR, notifications, documents and operational defaults. Values are stored in the database, applied immediately and recorded in the audit log."
        actions={
          <div className="global-search">
            <input
              className="search-input"
              placeholder="Search settings..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      />
      {error && <ErrorBanner error={error} />}
      {!editable && (
        <div className="notice-banner">
          <span>Read-only view. Ask an administrator with Settings update permission to change these values.</span>
        </div>
      )}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {cats.map((cat) => {
            const isActive = !query && active === cat.category;
            const custom = Object.values(cat.settings).filter((s) => s.saved).length;
            return (
              <button
                key={cat.category}
                className={isActive ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => { setActive(cat.category); setQuery(''); }}
                title={cat.blurb}
              >
                <span className={`settings-nav-tile ${SETTING_TILE[cat.category] ?? 'tile-neutral'}`}>
                  {cat.label.slice(0, 2)}
                </span>
                <span className="settings-nav-body">
                  <span className="settings-nav-label">{cat.label}</span>
                  <span className="settings-nav-meta">{custom > 0 ? `${custom} custom` : 'Defaults'}</span>
                </span>
                {dirtyKeys[cat.category] > 0 && <span className="settings-dot" title="Unsaved changes" />}
              </button>
            );
          })}
        </nav>
        <div className="settings-main">
          {matches ? (
            matches.length === 0 ? (
              <div className="card">
                <div className="empty-state">
                  <h3>No matching settings</h3>
                  <p className="muted">Try a different search term.</p>
                </div>
              </div>
            ) : (
              (() => {
                const grouped = new Map<string, { cat: SettingCategory; items: { key: string; setting: SettingValue }[] }>();
                for (const m of matches) {
                  if (!grouped.has(m.cat.category)) grouped.set(m.cat.category, { cat: m.cat, items: [] });
                  grouped.get(m.cat.category)!.items.push({ key: m.key, setting: m.setting });
                }
                return (
                  <>
                    <div className="muted" style={{ marginBottom: 10 }}>
                      {matches.length} match{matches.length === 1 ? '' : 'es'} across {grouped.size} categor{grouped.size === 1 ? 'y' : 'ies'}
                    </div>
                    {Array.from(grouped.values()).map(({ cat, items }) => (
                      <section className="card" key={cat.category}>
                        <div className="card-head">
                          <h3>{cat.label}</h3>
                          <span className="badge badge-neutral">{items.length}</span>
                        </div>
                        <div className="card-pad">
                          <div className="setting-list">
                            {items.map(({ key, setting }) => renderRow(cat, key, setting))}
                          </div>
                        </div>
                      </section>
                    ))}
                  </>
                );
              })()
            )
          ) : (
            <div className="stack">
              <div className="muted" style={{ fontSize: 13 }}>{activeCat.blurb}</div>
              {renderCategoryCard(activeCat)}
            </div>
          )}
        </div>
      </div>
      {toast && (
        <div className="toast" style={{ background: toast.kind === 'err' ? 'var(--clay)' : 'var(--moss)', color: '#fff' }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

const AUDIT_ACTIONS = [
  '', 'create', 'update', 'delete', 'approve', 'reject', 'submit', 'cancel', 'void',
  'activate', 'suspend', 'disable', 'unlock', 'revoke', 'assign', 'transfer',
  'login', 'logout', 'scan', 'verify', 'export', 'import', 'request_restore',
];

function jsonRows(v: unknown): Array<[string, string]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v as Rec)
    .filter(([, x]) => x !== null && x !== undefined && x !== '')
    .map(([k, x]) => [labelize(k), typeof x === 'object' ? JSON.stringify(x) : String(x)]);
}

function Audit() {
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(Number(q.get('page')) || 1);
  const [resource, setResource] = useState(q.get('resource') ?? '');
  const [action, setAction] = useState(q.get('action') ?? '');
  const [userId, setUserId] = useState(q.get('user_id') ?? '');
  const [resInput, setResInput] = useState(q.get('resource') ?? '');
  const [uidInput, setUidInput] = useState(q.get('user_id') ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const pageSize = 25;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (resource) params.set('resource', resource);
    if (action) params.set('action', action);
    if (userId) params.set('user_id', userId);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; pagination: { total: number } } }>(`/api/admin/audit-logs?${params.toString()}`)
      .then((r) => { if (alive) { setRows(r.data?.rows ?? []); setTotal(r.data?.pagination?.total ?? 0); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Audit log failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, resource, action, userId]);

  const submitFilters = (ev: React.FormEvent) => {
    ev.preventDefault();
    setResource(resInput.trim());
    setUserId(uidInput.trim());
    setPage(1);
  };

  const pickAction = (a: string) => {
    setAction(action === a ? '' : a);
    setPage(1);
  };

  return (
    <div className="page">
      <AdminHeader
        title="Audit log"
        sub="Every critical action across the ERP - who, what, when, from what value and to what value. Audit records cannot be edited."
      />
      <form className="toolbar" onSubmit={submitFilters}>
        <input
          className="search-input"
          placeholder="Filter by resource (e.g. users, roles, settings.security)"
          value={resInput}
          onChange={(e) => setResInput(e.target.value)}
        />
        <input
          className="search-input"
          style={{ maxWidth: 140 }}
          placeholder="User ID"
          value={uidInput}
          onChange={(e) => setUidInput(e.target.value)}
        />
        <button className="btn btn-sm btn-primary" type="submit">Apply</button>
        {(resource || userId || action) && (
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => { setResource(''); setUserId(''); setAction(''); setResInput(''); setUidInput(''); setPage(1); }}
          >
            Clear
          </button>
        )}
      </form>
      <div className="chips" style={{ marginBottom: 12 }}>
        {AUDIT_ACTIONS.map((a) => (
          <button
            key={a || 'all'}
            className={a === action ? 'chip chip-on' : 'chip'}
            onClick={() => pickAction(a)}
          >
            {a || 'ALL ACTIONS'}
          </button>
        ))}
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No audit events" body="Events will appear here as users perform audited actions." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Record</th>
                  <th>IP</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const id = Number(r.id);
                  const open = openId === id;
                  return (
                    <Fragment key={id}>
                      <tr key={id}>
                        <td className="td-cell-mono">{fmtDate(r.createdAt)}</td>
                        <td>{s(r.actor) || s(r.actorEmail)}</td>
                        <td><Badge value={labelize(r.action)} /></td>
                        <td>{labelize(r.resource)}</td>
                        <td className="td-cell-mono">{s(r.recordCode)}</td>
                        <td className="td-cell-mono">{s(r.ip)}</td>
                        <td>
                          <button
                            className="btn btn-sm"
                            onClick={() => setOpenId(open ? null : id)}
                          >
                            {open ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${id}-d`} className="audit-detail-row">
                          <td colSpan={7}>
                            <div className="def-list">
                              {jsonRows(r.oldValues).length === 0 && jsonRows(r.newValues).length === 0 ? (
                                <p className="muted">No field-level changes recorded for this event.</p>
                              ) : (
                                <div className="grid-2">
                                  <div className="def-sec">
                                    <div className="def-sec-head"><h4>Previous value</h4></div>
                                    {jsonRows(r.oldValues).map(([k, v]) => (
                                      <div className="def-row" key={k}>
                                        <dt>{k}</dt>
                                        <dd className="td-cell-mono">{v}</dd>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="def-sec">
                                    <div className="def-sec-head"><h4>New value</h4></div>
                                    {jsonRows(r.newValues).map(([k, v]) => (
                                      <div className="def-row" key={k}>
                                        <dt>{k}</dt>
                                        <dd className="td-cell-mono">{v}</dd>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: 'badge-green',
  OK: 'badge-green',
  WARNING: 'badge-amber',
  DEGRADED: 'badge-hold',
  CRITICAL: 'badge-critical',
  OFFLINE: 'badge-neutral',
};

function healthBadge(st: unknown) {
  const key = String(st ?? '').toUpperCase();
  return <span className={`badge ${HEALTH_TONE[key] ?? 'badge-neutral'}`}>{labelize(st)}</span>;
}

function Features() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const load = () => {
    setLoading(true);
    setError('');
    api<{ data: Rec[] }>('/api/admin/features')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Features failed'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [s(r.module), s(r.feature), s(r.environment), s(r.companyName), s(r.branchName)]
        .join(' ').toLowerCase().includes(q)
    );
  }, [query, rows]);

  const toggle = async (r: Rec) => {
    try {
      await api('/api/admin/features', {
        method: 'POST',
        body: JSON.stringify({
          module: s(r.module),
          feature: s(r.feature),
          company_id: r.companyId != null ? Number(r.companyId) : undefined,
          branch_id: r.branchId != null ? Number(r.branchId) : undefined,
          enabled: !r.enabled,
          rollout: Number(r.rollout) || 100,
          environment: s(r.environment) || undefined,
          effective_from: s(r.effectiveFrom) || undefined,
          effective_to: s(r.effectiveTo) || undefined,
        }),
      });
      setToast({ kind: 'ok', text: `${s(r.module)}.${s(r.feature)} ${r.enabled ? 'disabled' : 'enabled'}` });
      load();
    } catch (e) {
      setToast({ kind: 'err', text: e instanceof Error ? e.message : 'Feature update failed' });
    }
  };

  return (
    <div className="page">
      <AdminHeader
        title="Feature management"
        sub="Enable, disable and gradually roll out platform capabilities. Enforcement is server-side - hiding a control in the UI is never enough."
        actions={
          <>
            <div className="global-search">
              <input className="search-input" placeholder="Search features..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add feature</button>
          </>
        }
      />
      {error && <ErrorBanner error={error} />}
      {loading ? (
        <Skeleton rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No feature flags" body="Add a feature flag to control module availability by environment and rollout." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Module</th>
                <th>Feature</th>
                <th>Scope</th>
                <th>Environment</th>
                <th>Rollout</th>
                <th>Effective</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={s(r.id)}>
                  <td className="td-cell-mono">{s(r.module)}</td>
                  <td>{s(r.feature)}</td>
                  <td>
                    {s(r.companyCode)
                      ? `${s(r.companyCode)}${s(r.branchCode) ? ` / ${s(r.branchCode)}` : ''}`
                      : <span className="muted">Tenant-wide</span>}
                  </td>
                  <td>{s(r.environment) || <span className="muted">all</span>}</td>
                  <td className="td-cell-mono">{fmtNum(r.rollout)}%</td>
                  <td className="td-cell-mono">
                    {s(r.effectiveFrom) ? `${fmtDate(r.effectiveFrom)}${s(r.effectiveTo) ? ` - ${fmtDate(r.effectiveTo)}` : ''}` : '-'}
                  </td>
                  <td>{r.enabled ? <span className="badge badge-green">Enabled</span> : <span className="badge badge-neutral">Disabled</span>}</td>
                  <td>
                    <div className="head-actions" style={{ gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                      <button className="btn btn-sm" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(showAdd || editing) && (
        <FeatureModal
          initial={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={(msg) => { setToast({ kind: 'ok', text: msg }); load(); }}
        />
      )}
      {toast && (
        <div className="toast" style={{ background: toast.kind === 'err' ? 'var(--clay)' : 'var(--moss)', color: '#fff' }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

function FeatureModal({ initial, onClose, onSaved }: { initial: Rec | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [module, setModule] = useState(s(initial?.module ?? ''));
  const [feature, setFeature] = useState(s(initial?.feature ?? ''));
  const [enabled, setEnabled] = useState(Boolean(initial?.enabled ?? true));
  const [environment, setEnvironment] = useState(s(initial?.environment ?? ''));
  const [rollout, setRollout] = useState(String(initial?.rollout ?? 100));
  const [from, setFrom] = useState(s(initial?.effectiveFrom ?? ''));
  const [to, setTo] = useState(s(initial?.effectiveTo ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>('/api/admin/features', {
        method: 'POST',
        body: JSON.stringify({
          module: module.trim(),
          feature: feature.trim(),
          enabled,
          rollout: Number(rollout) || 100,
          environment: environment || undefined,
          effective_from: from || undefined,
          effective_to: to || undefined,
        }),
      });
      onSaved(`${s(r.data?.module)}.${s(r.data?.feature)} saved`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save feature');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit feature flag' : 'Add feature flag'} onClose={onClose} footer={
      <>
        <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={submit}>
          {busy ? 'Saving...' : 'Save feature'}
        </button>
      </>
    }>
      {error && <ErrorBanner error={error} />}
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <label className="field field-required">
            <span>Module</span>
            <input value={module} onChange={(e) => setModule(e.target.value)} placeholder="e.g. admin" required />
          </label>
          <label className="field field-required">
            <span>Feature</span>
            <input value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="e.g. security.dashboard" required />
          </label>
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Environment</span>
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="">All environments</option>
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="development">Development</option>
            </select>
          </label>
          <label className="field">
            <span>Rollout percentage (0-100)</span>
            <input type="number" min={0} max={100} value={rollout} onChange={(e) => setRollout(e.target.value)} />
          </label>
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Effective from</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>Effective to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Feature enabled</span>
        </label>
        <p className="hint">Company and branch scoping default to the tenant. Scoped flags can be managed via the API.</p>
      </form>
    </Modal>
  );
}

function Health() {
  const company = useCompanyProfile();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setRefreshing(true);
    setError('');
    api<{ data: Rec }>('/api/admin/health')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Health check failed'))
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    load();
  }, []);

  const components = Array.isArray(data?.components) ? (data.components as Rec[]) : [];
  const jobs = (data?.jobs ?? {}) as Record<string, number>;
  const db = (data?.database ?? {}) as Rec;

  return (
    <div className="page">
      <AdminHeader
        title="Platform health"
        sub={`Application, database, background job and API health for the ${company.name} ERP control plane.`}
        actions={
          <button className="btn" disabled={refreshing} onClick={load}>
            {refreshing ? 'Checking...' : 'Refresh'}
          </button>
        }
      />
      {error && <ErrorBanner error={error} />}
      {!data && !error ? (
        <PageLoader label="Checking platform health..." />
      ) : (
        <>
          <div className="kpi-grid--tiles">
            <KpiTile label="Database tables" value={db.tables} sub="Public schema objects" icon="T" accent="#0e7490" tint="rgba(14,116,144,0.14)" href="/admin/health" />
            <KpiTile label="DB connections" value={db.connections} sub="Active pg_stat_activity rows" icon="C" accent="#7c3aed" tint="rgba(124,58,237,0.14)" href="/admin/health" />
            <KpiTile label="Database size" value={s(db.dbSize)} sub="Current database" icon="S" accent="#ca8a04" tint="rgba(202,138,4,0.14)" href="/admin/health" />
            <KpiTile label="Background jobs" value={Object.values(jobs).reduce((a, b) => a + b, 0)} sub="Across all statuses" icon="J" accent="#334155" tint="rgba(51,65,85,0.14)" href="/admin/health" />
          </div>
          <section className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-head">
              <div>
                <h3>Component status</h3>
                <span className="muted" style={{ fontSize: 12 }}>Last checked {data?.checkedAt ? fmtDate(data.checkedAt) : '-'}</span>
              </div>
            </div>
            {components.length === 0 ? (
              <p className="muted">No component health records yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Component</th><th>Status</th><th>Detail</th><th>Checked at</th></tr>
                  </thead>
                  <tbody>
                    {components.map((c) => (
                      <tr key={s(c.component)}>
                        <td>{labelize(c.component)}</td>
                        <td>{healthBadge(c.status)}</td>
                        <td className="muted">{s(c.detail)}</td>
                        <td className="td-cell-mono">{fmtDate(c.checkedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-head"><h3>Background jobs by status</h3></div>
            {Object.keys(jobs).length === 0 ? (
              <p className="muted">No background jobs recorded for this tenant.</p>
            ) : (
              <div className="chips">
                {Object.entries(jobs).map(([st, n]) => (
                  <span key={st} className="chip">
                    {healthBadge(st)} <span className="td-cell-mono">{fmtNum(n)}</span>
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function fmtBytes(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Backups() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restore, setRestore] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const load = () => {
    setLoading(true);
    setError('');
    api<{ data: Rec[] }>('/api/admin/backups')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Backups failed'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const requestRestore = async (reason: string) => {
    if (!restore) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/admin/backups/${s(restore.id)}/restore`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setRestore(null);
      setToast({ kind: 'ok', text: `Restore request ${s(r.data?.status)} for ${s(r.data?.backupId)} - awaiting approval` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore request failed');
      setToast({ kind: 'err', text: e instanceof Error ? e.message : 'Restore request failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <AdminHeader
        title="Backups & recovery"
        sub="Review backup records and request controlled restores. Restores require a reason, approval, MFA and a full audit trail."
        actions={<button className="btn" onClick={load}>Refresh</button>}
      />
      {error && <ErrorBanner error={error} />}
      {loading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No backups recorded" body="Backup records will appear here as backup jobs run." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Backup ID</th>
                <th>Type</th>
                <th>Scope</th>
                <th>Started</th>
                <th>Completed</th>
                <th>Size</th>
                <th>Retention</th>
                <th>Encrypted</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={s(r.id)}>
                  <td className="td-cell-mono">{s(r.backupId)}</td>
                  <td>{labelize(r.backupType)}</td>
                  <td>{labelize(r.scope)}</td>
                  <td className="td-cell-mono">{fmtDate(r.startedAt)}</td>
                  <td className="td-cell-mono">{fmtDate(r.completedAt)}</td>
                  <td className="td-cell-mono">{fmtBytes(r.sizeBytes)}</td>
                  <td className="td-cell-mono">{fmtNum(r.retentionDays)}d</td>
                  <td>{r.encrypted ? <span className="badge badge-green">Yes</span> : <span className="badge badge-neutral">No</span>}</td>
                  <td><Badge value={r.status} /></td>
                  <td>
                    <button className="btn btn-sm" disabled={!r.completedAt} onClick={() => setRestore(r)}>
                      Request restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restore && (
        <ConfirmDialog
          title="Request restore"
          body={`Request a restore of ${s(restore.backupId)} (${labelize(restore.backupType)}). This creates a pending restore request that requires MFA verification, approval and audit before recovery begins.`}
          confirmLabel={busy ? 'Submitting...' : 'Request restore'}
          danger
          onCancel={() => setRestore(null)}
          onConfirm={(reason) => requestRestore(reason)}
        />
      )}
      {toast && (
        <div className="toast" style={{ background: toast.kind === 'err' ? 'var(--clay)' : 'var(--moss)', color: '#fff' }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
