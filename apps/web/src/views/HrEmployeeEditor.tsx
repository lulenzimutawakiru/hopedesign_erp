import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { ErrorBanner, PageLoader } from '../components/ui';
import { type Rec } from './hrShared';

/**
 * Employee create and edit screens — the full-page forms behind
 * /people/employees/new and /people/employees/:id/edit. Lifted verbatim from
 * HrFlow so the flow file stops owning employee form presentation.
 */
export function EmployeeEditor({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [salaryType, setSalaryType] = useState('MONTHLY');
  const [hireDate, setHireDate] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [tin, setTin] = useState('');
  const [nssfNo, setNssfNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountNo, setBankAccountNo] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [groups, setGroups] = useState<Rec[]>([]);
  const [payrollGroupId, setPayrollGroupId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [payrollCurrency, setPayrollCurrency] = useState('');
  const [payrollEnabled, setPayrollEnabled] = useState(false);
  const [isSecondary, setIsSecondary] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([
      api<{ data: Rec[] }>('/api/ops/hr/departments'),
      api<{ data: Rec[] }>('/api/ops/hr/payroll-groups'),
      api<{ data: Rec }>(`/api/ops/hr/employees/${id}`),
    ])
      .then(([deptRes, groupRes, empRes]) => {
        setDepts(deptRes.data ?? []);
        setGroups(groupRes.data ?? []);
        const e = empRes.data.employee as Rec;
        setDoc(empRes.data);
        setFirstName(String(e.firstName ?? ''));
        setLastName(String(e.lastName ?? ''));
        setPosition(String(e.position ?? ''));
        setDepartmentId(e.departmentId != null ? String(e.departmentId) : '');
        setBaseSalary(e.baseSalary != null ? String(e.baseSalary) : '');
        setSalaryType(String(e.salaryType ?? 'MONTHLY'));
        setHireDate(String(e.hireDate ?? '').slice(0, 10));
        setEmail(String(e.email ?? ''));
        setPhone(String(e.phone ?? ''));
        setTin(String(e.tin ?? ''));
        setNssfNo(String(e.nssfNo ?? ''));
        setBankName(String(e.bankName ?? ''));
        setBankAccountNo(String(e.bankAccountNo ?? ''));
        setStatus(String(e.status ?? 'ACTIVE'));
        setPayrollGroupId(e.payrollGroupId != null ? String(e.payrollGroupId) : '');
        setPaymentMethod(String(e.paymentMethod ?? ''));
        setPayrollCurrency(String(e.payrollCurrency ?? ''));
        setPayrollEnabled(Boolean(e.payrollEnabled));
        setIsSecondary(Boolean(e.isSecondaryEmployment));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Employee failed'));
  }, [id]);
  const canEdit = can(user, 'hr.employees.update');
  const save = async () => {
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName, lastName,
          position: position.trim() || null,
          departmentId: departmentId ? Number(departmentId) : null,
          baseSalary: baseSalary ? Number(baseSalary) : 0,
          salaryType,
          hireDate: hireDate || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          tin: tin.trim() || null,
          nssfNo: nssfNo.trim() || null,
          bankName: bankName.trim() || null,
          bankAccountNo: bankAccountNo.trim() || null,
          status,
          payrollEnabled,
          isSecondaryEmployment: isSecondary,
          payrollGroupId: payrollGroupId ? Number(payrollGroupId) : null,
          paymentMethod: paymentMethod || null,
          payrollCurrency: payrollCurrency.trim() || null,
        }),
      });
      navigate(`/people/employees/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening employee..." />;
  const e = doc.employee as Rec;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(`/people/employees/${id}`)}>Back</button>
          <p className="mod-kicker" data-mod="hr">Employee file</p>
          <h1>Edit {String(e.firstName)} {String(e.lastName)}</h1>
        </div>
      </header>
      {!canEdit && <ErrorBanner error={new Error('You need the HR employee update permission to edit this record.')} />}
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>First name</label><input value={firstName} onChange={(ev) => setFirstName(ev.target.value)} /></div>
          <div className="field field-required"><label>Last name</label><input value={lastName} onChange={(ev) => setLastName(ev.target.value)} /></div>
          <div className="field"><label>Position</label><input value={position} onChange={(ev) => setPosition(ev.target.value)} /></div>
          <div className="field">
            <label>Department</label>
            <select value={departmentId} onChange={(ev) => setDepartmentId(ev.target.value)}>
              <option value="">-</option>
              {depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.code)} - {String(d.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Hire date</label><input type="date" value={hireDate} onChange={(ev) => setHireDate(ev.target.value)} /></div>
          <div className="field">
            <label>Salary type</label>
            <select value={salaryType} onChange={(ev) => setSalaryType(ev.target.value)}>
              <option value="MONTHLY">Monthly</option>
              <option value="HOURLY">Hourly</option>
              <option value="COMMISSION">Commission</option>
            </select>
          </div>
          <div className="field"><label>Basic pay</label><input inputMode="decimal" value={baseSalary} onChange={(ev) => setBaseSalary(ev.target.value)} /></div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(ev) => setStatus(ev.target.value)}>
              <option value="ACTIVE">Active</option>
              <option value="PROBATION">Probation</option>
              <option value="ON_LEAVE">On leave</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          <div className="field"><label>Work email</label><input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(ev) => setPhone(ev.target.value)} /></div>
          <div className="field"><label>TIN</label><input value={tin} onChange={(ev) => setTin(ev.target.value)} /></div>
          <div className="field"><label>NSSF no</label><input value={nssfNo} onChange={(ev) => setNssfNo(ev.target.value)} /></div>
          <div className="field"><label>Bank</label><input value={bankName} onChange={(ev) => setBankName(ev.target.value)} /></div>
          <div className="field"><label>Account no</label><input value={bankAccountNo} onChange={(ev) => setBankAccountNo(ev.target.value)} /></div>
          <div className="field">
            <label>Payroll group</label>
            <select value={payrollGroupId} onChange={(ev) => setPayrollGroupId(ev.target.value)}>
              <option value="">Not in a group</option>
              {groups.map((g) => <option key={String(g.id)} value={String(g.id)}>{String(g.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Pay method</label>
            <select value={paymentMethod} onChange={(ev) => setPaymentMethod(ev.target.value)}>
              <option value="">Not set</option>
              <option value="BANK">Bank</option>
              <option value="MOBILE_MONEY">Mobile money</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </div>
          <div className="field"><label>Payroll currency</label><input maxLength={3} value={payrollCurrency} onChange={(ev) => setPayrollCurrency(ev.target.value.toUpperCase())} placeholder="UGX" /></div>
          <div className="field">
            <label>Payroll enrolment</label>
            <select value={payrollEnabled ? 'yes' : 'no'} onChange={(ev) => setPayrollEnabled(ev.target.value === 'yes')}>
              <option value="yes">Included in payroll runs</option>
              <option value="no">Excluded from payroll runs</option>
            </select>
            <p className="muted">Staff who are not enrolled are left out of every payroll run.</p>
          </div>
          <div className="field">
            <label>Secondary employment</label>
            <select value={isSecondary ? 'yes' : 'no'} onChange={(ev) => setIsSecondary(ev.target.value === 'yes')}>
              <option value="no">Only employment</option>
              <option value="yes">Second employment</option>
            </select>
            <p className="muted">Taxed at a fixed rate instead of the resident PAYE bands, and no NSSF is withheld here.</p>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !canEdit} onClick={save}>Save changes</button>
      </section>
    </div>
  );
}

export function EmployeeComposer() {
  const returnTo = useHashQuery().get('returnTo') ?? '';
  const [depts, setDepts] = useState<Rec[]>([]);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [baseSalary, setBaseSalary] = useState('1500000');
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState<Rec[]>([]);
  const [payrollGroupId, setPayrollGroupId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [payrollCurrency, setPayrollCurrency] = useState('');
  const [payrollEnabled, setPayrollEnabled] = useState(true);
  const [isSecondary, setIsSecondary] = useState(false);
  const [userId, setUserId] = useState('');
  const [userQ, setUserQ] = useState('');
  const [userHits, setUserHits] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments').then((r) => setDepts(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hr/payroll-groups').then((r) => setGroups(r.data ?? [])).catch(() => undefined);
  }, []);
  const searchUsers = async () => {
    if (!userQ.trim()) { setUserHits([]); return; }
    try {
      const r = await api<{ data: Rec[] }>(`/api/ops/hr/directory/users?unlinked=1&q=${encodeURIComponent(userQ.trim())}`);
      setUserHits(r.data ?? []);
    } catch {
      setUserHits([]);
    }
  };
  const save = async () => {
    if (!firstName.trim() || !lastName.trim()) { setError('Name is required'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { employeeId: number } }>('/api/ops/hr/employees', {
        method: 'POST',
        body: JSON.stringify({
          firstName, lastName, position, departmentId: departmentId ? Number(departmentId) : null,
          baseSalary: Number(baseSalary) || 0,
          email: email.trim() || null,
          payrollEnabled,
          isSecondaryEmployment: isSecondary,
          payrollGroupId: payrollGroupId ? Number(payrollGroupId) : null,
          paymentMethod: paymentMethod || null,
          payrollCurrency: payrollCurrency.trim() || null,
          userId: userId ? Number(userId) : null,
        }),
      });
      if (returnTo) navigate('/people/' + returnTo, { query: { hired: '1' } });
      else navigate(`/people/employees/${r.data.employeeId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const picked = userHits.find((u) => String(u.id) === userId);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(returnTo ? '/people/' + returnTo : '/people/employees')}>Back</button>
          <h1>New employee</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="field field-required"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          <div className="field"><label>Position</label><input value={position} onChange={(e) => setPosition(e.target.value)} /></div>
          <div className="field">
            <label>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">—</option>
              {depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.code)} · {String(d.name)}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Monthly basic</label><input inputMode="decimal" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} /></div>
          <div className="field"><label>Work email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Used to match an existing ERP login" /></div>
          <div className="field">
            <label>Payroll group</label>
            <select value={payrollGroupId} onChange={(e) => setPayrollGroupId(e.target.value)}>
              <option value="">Not in a group</option>
              {groups.map((g) => <option key={String(g.id)} value={String(g.id)}>{String(g.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Pay method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="">Not set</option>
              <option value="BANK">Bank</option>
              <option value="MOBILE_MONEY">Mobile money</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </div>
          <div className="field"><label>Payroll currency</label><input maxLength={3} value={payrollCurrency} onChange={(e) => setPayrollCurrency(e.target.value.toUpperCase())} placeholder="UGX" /></div>
          <div className="field">
            <label>Payroll enrolment</label>
            <select value={payrollEnabled ? 'yes' : 'no'} onChange={(e) => setPayrollEnabled(e.target.value === 'yes')}>
              <option value="yes">Included in payroll runs</option>
              <option value="no">Excluded from payroll runs</option>
            </select>
          </div>
          <div className="field">
            <label>Secondary employment</label>
            <select value={isSecondary ? 'yes' : 'no'} onChange={(e) => setIsSecondary(e.target.value === 'yes')}>
              <option value="no">Only employment</option>
              <option value="yes">Second employment</option>
            </select>
            <p className="muted">Taxed at a fixed rate instead of the resident PAYE bands, and no NSSF is withheld here.</p>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>ERP user account</label>
          <p className="muted">Optional. Link an existing login now, or match later by the same email.</p>
          {userId && picked ? (
            <p>
              <span className="cell-mono">{String(picked.username || picked.email)}</span>
              {' '}<button type="button" className="btn btn-sm" onClick={() => { setUserId(''); setUserHits([]); setUserQ(''); }}>Clear</button>
            </p>
          ) : (
            <div className="toolbar">
              <input className="search-input" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Search username or email" onKeyDown={(ev) => { if (ev.key === 'Enter') void searchUsers(); }} />
              <button type="button" className="btn btn-sm" onClick={() => void searchUsers()}>Search</button>
            </div>
          )}
          {!userId && userHits.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data">
                <tbody>
                  {userHits.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="cell-mono">{String(row.username ?? '')}</td>
                      <td>{String(row.email ?? '')}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setUserId(String(row.id))}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save employee</button>
      </section>
    </div>
  );
}
