import { useCallback, useEffect, useState } from 'react';
import { api, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { Badge, ErrorBanner, Modal } from '../components/ui';
import { HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';
import { type Rec } from './hrShared';

/**
 * Odoo "Salary Rules" parity — the live payroll component catalogue
 * (`payroll_component_definitions`), i.e. the rules the engine actually reads,
 * not the unused `salary_structures` tables.
 */

const TYPES = ['EARNING', 'DEDUCTION'];
const CATEGORIES = ['ALLOWANCE', 'BONUS', 'OVERTIME', 'REIMBURSEMENT', 'LOAN', 'ADVANCE', 'TAX', 'STATUTORY', 'OTHER'];
const CALC_TYPES = ['FIXED', 'PERCENTAGE', 'FORMULA'];
const STATUSES = ['ACTIVE', 'INACTIVE'];

const empty = { code: '', name: '', type: 'EARNING', category: 'ALLOWANCE', calculation_type: 'FIXED', value: '', is_taxable: true, is_benefit_in_kind: false, status: 'ACTIVE', formula: '' };

function typeBadge(v: unknown) {
  const s = String(v ?? '');
  if (s === 'DEDUCTION') return <Badge value="DEDUCTION" />;
  return <Badge value="EARNING" />;
}
function catLabel(v: unknown) {
  const s = String(v ?? '');
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}
function calcLabel(v: unknown) {
  const s = String(v ?? '');
  return s.charAt(0) + s.slice(1).toLowerCase();
}
function valueLabel(r: Rec) {
  if (String(r.calculationType ?? '') === 'FORMULA') return <span className="cell-mono">Formula</span>;
  if (r.value == null) return '-';
  return <span className="cell-num">{fmtNum(Number(r.value))}{String(r.calculationType ?? '') === 'PERCENTAGE' ? '%' : ''}</span>;
}

interface FormState { code: string; name: string; type: string; category: string; calculation_type: string; value: string; is_taxable: boolean; is_benefit_in_kind: boolean; status: string; formula: string }

function RuleForm({ initial, onSave, onClose }: { initial: Rec | null; onSave: (body: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<FormState>(() => {
    if (!initial) return { ...empty };
    return {
      code: String(initial.code ?? ''),
      name: String(initial.name ?? ''),
      type: String(initial.type ?? 'EARNING'),
      category: String(initial.category ?? 'OTHER'),
      calculation_type: String(initial.calculationType ?? 'FIXED'),
      value: initial.value == null ? '' : String(initial.value),
      is_taxable: initial.isTaxable !== false,
      is_benefit_in_kind: initial.isBenefitInKind === true,
      status: String(initial.status ?? 'ACTIVE'),
      formula: initial.formula == null ? '' : JSON.stringify(initial.formula),
    };
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormState, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr('');
    if (!f.code.trim() || !f.name.trim()) { setErr('Code and name are required.'); return; }
    const body: Record<string, unknown> = {
      code: f.code.trim(),
      name: f.name.trim(),
      type: f.type,
      category: f.category,
      calculation_type: f.calculation_type,
      is_taxable: f.is_taxable,
      is_benefit_in_kind: f.is_benefit_in_kind,
      status: f.status,
      value: f.value.trim() === '' ? null : Number(f.value),
    };
    if (f.calculation_type === 'FORMULA') {
      if (!f.formula.trim()) { setErr('A formula is required when calculation type is FORMULA.'); return; }
      try {
        body.formula = JSON.parse(f.formula.trim());
        body.value = null;
      } catch {
        setErr('Formula must be valid JSON.'); return;
      }
    } else {
      body.formula = null;
    }
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={initial ? 'Edit salary rule' : 'New salary rule'} onClose={onClose} wide
      footer={
        <div className="action-group">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button>
        </div>
      }>
      {err && <ErrorBanner error={err} />}
      <div className="stack">
        <div className="grid-2">
          <div className="field"><label className="field-required">Code</label><input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. BASIC, PAYE, LST" /></div>
          <div className="field"><label className="field-required">Name</label><input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Basic salary" /></div>
        </div>
        <div className="grid-2">
          <div className="field"><label>Type</label>
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t === 'EARNING' ? 'Earning' : 'Deduction'}</option>)}
            </select>
          </div>
          <div className="field"><label>Category</label>
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div className="field"><label>Calculation type</label>
            <select value={f.calculation_type} onChange={(e) => set('calculation_type', e.target.value)}>
              {CALC_TYPES.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
            </select>
          </div>
          <div className="field"><label>Status</label>
            <select value={f.status} onChange={(e) => set('status', e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s === 'ACTIVE' ? 'Active' : 'Inactive'}</option>)}
            </select>
          </div>
        </div>
        {f.calculation_type !== 'FORMULA' ? (
          <div className="field"><label>Value{f.calculation_type === 'PERCENTAGE' ? ' (%)' : ' (UGX)'}</label><input type="number" step="any" value={f.value} onChange={(e) => set('value', e.target.value)} placeholder="0" /></div>
        ) : (
          <div className="field"><label>Formula (JSON)</label><textarea rows={5} value={f.formula} onChange={(e) => set('formula', e.target.value)} placeholder='{"expression": "basic * 0.3"}' /></div>
        )}
        <div className="field" style={{ display: 'flex', gap: 20, flexDirection: 'row', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.is_taxable} onChange={(e) => set('is_taxable', e.target.checked)} /> Taxable
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.is_benefit_in_kind} onChange={(e) => set('is_benefit_in_kind', e.target.checked)} /> Benefit in kind
          </label>
        </div>
      </div>
    </Modal>
  );
}

export default function SalaryRules() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'hr.payroll_components.create');
  const canUpdate = can(user, 'hr.payroll_components.update');

  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; totalCount: number } }>('/api/ops/hr/salary-components?pageSize=500')
      .then((r) => { setRows(r.data.rows ?? []); setTotalCount(r.data.totalCount ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Salary rules failed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = rows.filter((r) => {
    if (type && String(r.type ?? '') !== type) return false;
    if (category && String(r.category ?? '') !== category) return false;
    if (status && String(r.status ?? '') !== status) return false;
    if (!q.trim()) return true;
    return (String(r.code ?? '') + ' ' + String(r.name ?? '')).toLowerCase().includes(q.trim().toLowerCase());
  });

  const active = rows.filter((r) => String(r.status ?? '') === 'ACTIVE').length;
  const earnings = rows.filter((r) => String(r.type ?? '') === 'EARNING').length;
  const deductions = rows.filter((r) => String(r.type ?? '') === 'DEDUCTION').length;

  const save = async (body: Record<string, unknown>) => {
    if (editing) {
      await api(`/api/ops/hr/salary-components/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/api/ops/hr/salary-components', { method: 'POST', body: JSON.stringify(body) });
    }
    setEditing(null); setCreating(false); load();
  };

  return (
    <div className="page">
      <HrPageHeader kicker="Payroll" title="Salary rules" subtitle="The component catalogue the payroll engine reads to build every payslip."
        actions={canCreate ? <button className="btn btn-primary" onClick={() => { setEditing(null); setCreating(true); }}>New rule</button> : undefined} />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Rules" value={fmtNum(totalCount)} sub={fmtNum(active) + ' active'} />
        <HrKpi label="Earnings" value={fmtNum(earnings)} sub="Added to gross" accent="var(--success)" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Deductions" value={fmtNum(deductions)} sub="Taken from pay" accent="var(--warning)" tint="rgba(217, 119, 6, 0.12)" />
      </HrKpiGrid>
      <HrToolbar>
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or name..." aria-label="Search salary rules" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="EARNING">Earnings</option>
          <option value="DEDUCTION">Deductions</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(visible.length)} of {fmtNum(rows.length)} rules</span>
      </HrToolbar>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Category</th><th>Calculation</th><th className="cell-num">Value</th><th>Tax</th><th>Status</th><th className="cell-num">Assigned</th><th /></tr></thead>
          <tbody>
            {visible.map((r) => (
              <tr key={String(r.id)} className={canUpdate ? 'row-click' : ''} onClick={() => canUpdate && setEditing(r)}>
                <td className="cell-mono">{String(r.code ?? '-')}</td>
                <td><span className="td-strong">{String(r.name ?? '-')}</span></td>
                <td>{typeBadge(r.type)}</td>
                <td>{catLabel(r.category)}</td>
                <td>{calcLabel(r.calculationType)}</td>
                <td className="cell-num">{valueLabel(r)}</td>
                <td>
                  <span className="cell-sub">{r.isTaxable ? 'Taxable' : 'Non-taxable'}</span>
                  {r.isBenefitInKind === true && <span className="cell-sub">BiK</span>}
                </td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.assignedCount ?? 0)}</td>
                <td>{canUpdate && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <HrTableEmpty colSpan={10} title={rows.length === 0 ? 'No salary rules yet' : 'No rules match your filters'} hint={rows.length === 0 ? 'Create a rule to start configuring payroll.' : 'Try a different search or filter.'} />
            )}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <RuleForm initial={editing} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}
