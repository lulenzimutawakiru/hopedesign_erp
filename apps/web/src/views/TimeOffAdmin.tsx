import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal } from '../components/ui';

type Rec = Record<string, unknown>;

/**
 * Odoo "Time Off" parity — the configuration screens behind leave management:
 * time off types, accrual plans, manual allocations and the public-holiday
 * calendar. Requests / balances / the team calendar already existed; these
 * were the gaps.
 */

const TABS: [string, string][] = [
  ['types', 'Time Off Types'],
  ['plans', 'Accrual Plans'],
  ['allocations', 'Allocations'],
  ['holidays', 'Public Holidays'],
];

const CATEGORIES = ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'UNPAID', 'STUDY', 'COMPASSIONATE', 'BEREAVEMENT', 'PUBLIC', 'OTHER'];
const ACCRUAL_METHODS = ['MONTHLY_PROPORTION', 'YEARLY_LUMP', 'PER_DAY_WORKED', 'NONE'];
const APPLIES_TO = ['ALL', 'FULL_TIME', 'PART_TIME', 'PROBATION', 'CONTRACT'];
const RULE_TYPES = ['MONTHLY_PROPORTION', 'YEARLY_LUMP', 'PER_DAY_WORKED'];

const str = (v: unknown) => (v == null ? '' : String(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : '-');
const human = (v: unknown) => str(v).charAt(0) + str(v).slice(1).toLowerCase().replace(/_/g, ' ');

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div className={`field${required ? ' field-required' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  );
}

function TabBar({ active }: { active: string }) {
  return (
    <div className="otc-tabs">
      {TABS.map(([key, label]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} onClick={() => navigate('/people/time-off/' + key)}>{label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time Off Types
// ---------------------------------------------------------------------------

interface TypeForm { code: string; name: string; category: string; daysPerYear: string; maxConsecutiveDays: string; carryoverLimit: string; isPaid: boolean; requiresApproval: boolean; status: string }

function TypeFormModal({ initial, onSave, onClose }: { initial: Rec | null; onSave: (b: Rec) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<TypeForm>(() => ({
    code: initial ? String(initial.code ?? '') : '',
    name: initial ? String(initial.name ?? '') : '',
    category: initial ? String(initial.category ?? 'OTHER') : 'OTHER',
    daysPerYear: initial ? (initial.daysPerYear == null ? '' : String(initial.daysPerYear)) : '',
    maxConsecutiveDays: initial ? (initial.maxConsecutiveDays == null ? '' : String(initial.maxConsecutiveDays)) : '',
    carryoverLimit: initial ? String(initial.carryoverLimit ?? '') : '0',
    isPaid: initial ? initial.isPaid !== false : true,
    requiresApproval: initial ? initial.requiresApproval !== false : true,
    status: initial ? String(initial.status ?? 'ACTIVE') : 'ACTIVE',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof TypeForm, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setErr('');
    if (!f.code.trim() || !f.name.trim()) { setErr('Code and name are required.'); return; }
    const body: Rec = {
      code: f.code.trim(), name: f.name.trim(), category: f.category,
      daysPerYear: f.daysPerYear.trim() === '' ? null : Number(f.daysPerYear),
      maxConsecutiveDays: f.maxConsecutiveDays.trim() === '' ? null : Number(f.maxConsecutiveDays),
      carryoverLimit: f.carryoverLimit.trim() === '' ? 0 : Number(f.carryoverLimit),
      isPaid: f.isPaid, requiresApproval: f.requiresApproval, status: f.status,
    };
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={initial ? 'Edit time off type' : 'New time off type'} onClose={onClose} wide
      footer={<div className="action-group">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <Field label="Code" required><input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="ANNUAL" /></Field>
        <Field label="Name" required><input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Annual leave" /></Field>
        <Field label="Category">
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{human(c)}</option>)}
          </select>
        </Field>
        <Field label="Days per year"><input type="number" step="any" value={f.daysPerYear} onChange={(e) => set('daysPerYear', e.target.value)} /></Field>
        <Field label="Max consecutive days"><input type="number" step="any" value={f.maxConsecutiveDays} onChange={(e) => set('maxConsecutiveDays', e.target.value)} /></Field>
        <Field label="Carryover limit"><input type="number" step="any" value={f.carryoverLimit} onChange={(e) => set('carryoverLimit', e.target.value)} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </Field>
        <div className="field" style={{ display: 'flex', gap: 20, alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.isPaid} onChange={(e) => set('isPaid', e.target.checked)} /> Paid
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} /> Requires approval
          </label>
        </div>
      </div>
    </Modal>
  );
}

function TypesTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'hr.leave_types.create');
  const canUpdate = can(user, 'hr.leave_types.update');
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/leave/types')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Time off types failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async (b: Rec) => {
    if (editing) await api(`/api/ops/hcm/leave/types/${editing.id}`, { method: 'PATCH', body: JSON.stringify(b) });
    else await api('/api/ops/hcm/leave/types', { method: 'POST', body: JSON.stringify(b) });
    setEditing(null); setCreating(false); load();
  };
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <span className="muted">{fmtNum(rows.length)} types</span>
        {canCreate && <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(null); setCreating(true); }}>New type</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Category</th><th className="cell-num">Days / year</th><th className="cell-num">Carryover</th><th>Paid</th><th>Approval</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={canUpdate ? 'row-click' : ''} onClick={() => canUpdate && setEditing(r)}>
                <td className="cell-mono">{str(r.code)}</td>
                <td className="td-strong">{str(r.name)}</td>
                <td>{human(r.category)}</td>
                <td className="cell-num">{r.daysPerYear == null ? '-' : fmtNum(r.daysPerYear)}</td>
                <td className="cell-num">{fmtNum(r.carryoverLimit ?? 0)}</td>
                <td>{r.isPaid ? 'Paid' : 'Unpaid'}</td>
                <td>{r.requiresApproval ? 'Yes' : 'No'}</td>
                <td><Badge value={r.status} /></td>
                <td>{canUpdate && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No time off types configured.</td></tr>}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <TypeFormModal initial={editing} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accrual Plans
// ---------------------------------------------------------------------------

interface PlanForm { code: string; name: string; leaveTypeId: string; appliesTo: string; accrualMethod: string; effectiveFrom: string; effectiveTo: string; status: string; ruleType: string; accrualRate: string; cap: string; minimumServiceDays: string }

function PlanFormModal({ initial, types, onSave, onClose }: { initial: Rec | null; types: Rec[]; onSave: (b: Rec) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<PlanForm>(() => ({
    code: initial ? String(initial.code ?? '') : '',
    name: initial ? String(initial.name ?? '') : '',
    leaveTypeId: initial ? (initial.leaveTypeId == null ? '' : String(initial.leaveTypeId)) : '',
    appliesTo: initial ? String(initial.appliesTo ?? 'ALL') : 'ALL',
    accrualMethod: initial ? String(initial.accrualMethod ?? 'MONTHLY_PROPORTION') : 'MONTHLY_PROPORTION',
    effectiveFrom: initial ? day(initial.effectiveFrom) : '',
    effectiveTo: initial ? day(initial.effectiveTo) : '',
    status: initial ? String(initial.status ?? 'ACTIVE') : 'ACTIVE',
    ruleType: initial ? String(initial.ruleType ?? 'MONTHLY_PROPORTION') : 'MONTHLY_PROPORTION',
    accrualRate: initial ? (initial.accrualRate == null ? '' : String(initial.accrualRate)) : '',
    cap: initial ? (initial.cap == null ? '' : String(initial.cap)) : '',
    minimumServiceDays: initial ? String(initial.minimumServiceDays ?? '') : '',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof PlanForm, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setErr('');
    if (!f.code.trim() || !f.name.trim() || !f.effectiveFrom) { setErr('Code, name and effective-from date are required.'); return; }
    const body: Rec = {
      code: f.code.trim(), name: f.name.trim(),
      leaveTypeId: f.leaveTypeId ? Number(f.leaveTypeId) : null,
      appliesTo: f.appliesTo, accrualMethod: f.accrualMethod,
      effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null, status: f.status,
      ruleType: f.ruleType,
      accrualRate: f.accrualRate.trim() === '' ? null : Number(f.accrualRate),
      cap: f.cap.trim() === '' ? null : Number(f.cap),
      minimumServiceDays: f.minimumServiceDays.trim() === '' ? 0 : Number(f.minimumServiceDays),
    };
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={initial ? 'Edit accrual plan' : 'New accrual plan'} onClose={onClose} wide
      footer={<div className="action-group">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <Field label="Code" required><input value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Name" required><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Leave type">
          <select value={f.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={String(t.id)} value={String(t.id)}>{str(t.name)}</option>)}
          </select>
        </Field>
        <Field label="Applies to">
          <select value={f.appliesTo} onChange={(e) => set('appliesTo', e.target.value)}>
            {APPLIES_TO.map((a) => <option key={a} value={a}>{human(a)}</option>)}
          </select>
        </Field>
        <Field label="Accrual method">
          <select value={f.accrualMethod} onChange={(e) => set('accrualMethod', e.target.value)}>
            {ACCRUAL_METHODS.map((m) => <option key={m} value={m}>{human(m)}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </Field>
        <Field label="Effective from" required><input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></Field>
        <Field label="Effective to"><input type="date" value={f.effectiveTo} onChange={(e) => set('effectiveTo', e.target.value)} /></Field>
      </div>
      <div className="card-head" style={{ padding: '12px 0 4px' }}><h3>Accrual rule</h3></div>
      <div className="form-grid">
        <Field label="Rule type">
          <select value={f.ruleType} onChange={(e) => set('ruleType', e.target.value)}>
            {RULE_TYPES.map((m) => <option key={m} value={m}>{human(m)}</option>)}
          </select>
        </Field>
        <Field label="Accrual rate"><input type="number" step="any" value={f.accrualRate} onChange={(e) => set('accrualRate', e.target.value)} placeholder="e.g. 1.75" /></Field>
        <Field label="Cap"><input type="number" step="any" value={f.cap} onChange={(e) => set('cap', e.target.value)} /></Field>
        <Field label="Min service (days)"><input type="number" step="any" value={f.minimumServiceDays} onChange={(e) => set('minimumServiceDays', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function PlansTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [types, setTypes] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'hr.leave_policies.create');
  const canUpdate = can(user, 'hr.leave_policies.update');
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/hcm/leave/policies')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Accrual plans failed'));
    api<{ data: Rec[] }>('/api/ops/hcm/leave/types')
      .then((r) => setTypes(r.data ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async (b: Rec) => {
    if (editing) await api(`/api/ops/hcm/leave/policies/${editing.id}`, { method: 'PATCH', body: JSON.stringify(b) });
    else await api('/api/ops/hcm/leave/policies', { method: 'POST', body: JSON.stringify(b) });
    setEditing(null); setCreating(false); load();
  };
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <span className="muted">{fmtNum(rows.length)} plans</span>
        {canCreate && <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(null); setCreating(true); }}>New plan</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Leave type</th><th>Applies to</th><th>Accrual</th><th className="cell-num">Rate</th><th className="cell-num">Cap</th><th>Effective</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={canUpdate ? 'row-click' : ''} onClick={() => canUpdate && setEditing(r)}>
                <td className="cell-mono">{str(r.code)}</td>
                <td className="td-strong">{str(r.name)}</td>
                <td>{str(r.leaveTypeName ?? '-')}</td>
                <td>{human(r.appliesTo)}</td>
                <td>{human(r.accrualMethod)}</td>
                <td className="cell-num">{r.accrualRate == null ? '-' : fmtNum(r.accrualRate)}</td>
                <td className="cell-num">{r.cap == null ? '-' : fmtNum(r.cap)}</td>
                <td>{day(r.effectiveFrom)}{r.effectiveTo ? ` → ${day(r.effectiveTo)}` : ''}</td>
                <td><Badge value={r.status} /></td>
                <td>{canUpdate && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>No accrual plans configured.</td></tr>}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <PlanFormModal initial={editing} types={types} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

function AllocationsTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [types, setTypes] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const canAllocate = can(user, 'hr.leave_balances.update');
  const [form, setForm] = useState({ employeeId: '', leaveTypeId: '', year: String(new Date().getFullYear()), days: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec[] }>(`/api/ops/hcm/leave/balances?year=${year}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Balances failed'));
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=500')
      .then((r) => setEmployees(r.data.rows ?? []))
      .catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/leave/types')
      .then((r) => setTypes(r.data ?? []))
      .catch(() => undefined);
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const submit = async () => {
    setFormErr('');
    if (!form.employeeId || !form.leaveTypeId || form.days.trim() === '') { setFormErr('Employee, leave type and days are required.'); return; }
    setBusy(true);
    try {
      await api('/api/ops/hcm/leave/allocations', { method: 'POST', body: JSON.stringify({ employeeId: Number(form.employeeId), leaveTypeId: Number(form.leaveTypeId), year: Number(form.year), days: Number(form.days), note: form.note.trim() || null }) });
      setCreating(false);
      setForm({ employeeId: '', leaveTypeId: '', year: String(new Date().getFullYear()), days: '', note: '' });
      setNotice('Allocation recorded');
      load();
    } catch (e) { setFormErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <div className="field" style={{ margin: 0 }}><label className="visually-hidden" htmlFor="alloc-year">Year</label><input id="alloc-year" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" style={{ width: 110 }} /></div>
        <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(rows.length)} balances</span>
        {canAllocate && <button className="btn btn-primary" style={{ marginLeft: 12 }} onClick={() => setCreating(true)}>New allocation</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Employee</th><th>Type</th><th className="cell-num">Year</th><th className="cell-num">Opening</th><th className="cell-num">Accrued</th><th className="cell-num">Used</th><th className="cell-num">Adjusted</th><th className="cell-num">Available</th></tr></thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={String(r.id)}>
                <td><div className="cell-mono">{str(r.employeeNo)}</div><strong>{str(r.firstName)} {str(r.lastName)}</strong></td>
                <td>{str(r.leaveTypeName ?? r.leaveTypeCode ?? '-')}</td>
                <td className="cell-num">{fmtNum(r.year)}</td>
                <td className="cell-num">{fmtNum(r.openingBalance)}</td>
                <td className="cell-num">{fmtNum(r.accrued)}</td>
                <td className="cell-num">{fmtNum(r.used)}</td>
                <td className="cell-num">{fmtNum(r.adjusted)}</td>
                <td className="cell-num"><strong>{fmtNum(r.available)}</strong></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No balances for this year yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && (
        <Modal title="New leave allocation" onClose={() => setCreating(false)}
          footer={<div className="action-group">
            <button className="btn" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Record allocation'}</button>
          </div>}>
          {formErr && <ErrorBanner error={formErr} />}
          <div className="form-grid">
            <Field label="Employee" required>
              <select value={form.employeeId} onChange={(e) => setForm((p) => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map((em) => <option key={String(em.id)} value={String(em.id)}>{str(em.employeeNo)} - {str(em.firstName)} {str(em.lastName)}</option>)}
              </select>
            </Field>
            <Field label="Leave type" required>
              <select value={form.leaveTypeId} onChange={(e) => setForm((p) => ({ ...p, leaveTypeId: e.target.value }))}>
                <option value="">Select type…</option>
                {types.map((t) => <option key={String(t.id)} value={String(t.id)}>{str(t.name)}</option>)}
              </select>
            </Field>
            <Field label="Year" required><input type="number" min={2000} max={2100} value={form.year} onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))} /></Field>
            <Field label="Days (negative to revoke)" required><input type="number" step="any" value={form.days} onChange={(e) => setForm((p) => ({ ...p, days: e.target.value }))} /></Field>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><input value={form.note} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} /></div>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>Adds to (or, when negative, deducts from) the employee's adjusted balance and recomputes available days.</p>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public Holidays
// ---------------------------------------------------------------------------

interface HolidayForm { name: string; holidayDate: string; isRecurring: boolean; country: string }

function HolidayFormModal({ initial, onSave, onClose }: { initial: Rec | null; onSave: (b: Rec) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<HolidayForm>(() => ({
    name: initial ? String(initial.name ?? '') : '',
    holidayDate: initial ? day(initial.holidayDate) : '',
    isRecurring: initial ? initial.isRecurring === true : false,
    country: initial ? String(initial.country ?? 'UG') : 'UG',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof HolidayForm, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setErr('');
    if (!f.name.trim() || !f.holidayDate) { setErr('Name and date are required.'); return; }
    setBusy(true);
    try { await onSave({ name: f.name.trim(), holidayDate: f.holidayDate, isRecurring: f.isRecurring, country: f.country.trim() || 'UG' }); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={initial ? 'Edit holiday' : 'New holiday'} onClose={onClose}
      footer={<div className="action-group">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <Field label="Name" required><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Date" required><input type="date" value={f.holidayDate} onChange={(e) => set('holidayDate', e.target.value)} /></Field>
        <Field label="Country"><input value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
        <div className="field" style={{ display: 'flex', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.isRecurring} onChange={(e) => set('isRecurring', e.target.checked)} /> Recurring yearly
          </label>
        </div>
      </div>
    </Modal>
  );
}

function HolidaysTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'hr.holidays.create');
  const canUpdate = can(user, 'hr.holidays.update');
  const canDelete = can(user, 'hr.holidays.delete');
  const load = useCallback(() => {
    api<{ data: Rec[] }>(`/api/ops/hcm/holidays?year=${year}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Holidays failed'));
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const save = async (b: Rec) => {
    if (editing) await api(`/api/ops/hcm/holidays/${editing.id}`, { method: 'PATCH', body: JSON.stringify(b) });
    else await api('/api/ops/hcm/holidays', { method: 'POST', body: JSON.stringify(b) });
    setEditing(null); setCreating(false); load();
  };
  const remove = async (r: Rec) => {
    if (!window.confirm(`Delete holiday "${str(r.name)}"?`)) return;
    await api(`/api/ops/hcm/holidays/${r.id}`, { method: 'DELETE' });
    load();
  };
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <div className="field" style={{ margin: 0 }}><label className="visually-hidden" htmlFor="hol-year">Year</label><input id="hol-year" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" style={{ width: 110 }} /></div>
        <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(rows.length)} holidays</span>
        {canCreate && <button className="btn btn-primary" style={{ marginLeft: 12 }} onClick={() => { setEditing(null); setCreating(true); }}>New holiday</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Name</th><th>Date</th><th>Recurring</th><th>Country</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={canUpdate ? 'row-click' : ''} onClick={() => canUpdate && setEditing(r)}>
                <td className="td-strong">{str(r.name)}</td>
                <td>{day(r.holidayDate)}</td>
                <td>{r.isRecurring ? 'Yes' : 'No'}</td>
                <td>{str(r.country)}</td>
                <td>
                  {(canUpdate || canDelete) && (
                    <div className="row-actions">
                      {canUpdate && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}
                      {canDelete && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void remove(r); }}>Delete</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No holidays configured.</td></tr>}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <HolidayFormModal initial={editing} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function TimeOffAdmin({ tab }: { tab: string }) {
  const title = TABS.find(([k]) => k === tab)?.[1] ?? 'Time Off';
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Time Off</p>
          <h1>{title}</h1>
          <p className="muted">Leave types, entitlement accrual, manual allocations and the public-holiday calendar.</p>
        </div>
      </header>
      <TabBar active={tab} />
      {tab === 'types' ? <TypesTab /> : tab === 'plans' ? <PlansTab /> : tab === 'allocations' ? <AllocationsTab /> : <HolidaysTab />}
    </div>
  );
}
