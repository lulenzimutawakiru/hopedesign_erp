import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, StaffPhoto } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { HrEmptyState as EmptyState } from '../components/hrUi';
import { type Rec } from './hrShared';

/** Odoo "Employees" kanban — cards grouped by department with photos and tags. */
export function EmployeeKanban() {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Rec[]>([]);
  const [ungrouped, setUngrouped] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api<{ data: { departments: Rec[]; ungrouped: Rec[] } }>('/api/ops/hr/directory')
      .then((r) => {
        setGroups(r.data.departments ?? []);
        setUngrouped(r.data.ungrouped ?? []);
        setLoaded(true);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : 'Directory failed'); setLoaded(true); });
  }, []);
  const canCreate = can(user, 'hr.employees.create');

  const card = (e: Rec) => {
    const fullName = `${String(e.firstName ?? '')} ${String(e.lastName ?? '')}`.trim();
    const manager = e.managerFirstName ? `${String(e.managerFirstName)} ${String(e.managerLastName ?? '')}`.trim() : '';
    const tags = Array.isArray(e.tags) ? (e.tags as unknown[]).map(String) : [];
    return (
      <button key={String(e.id)} className="emp-kb-card" onClick={() => navigate(`/people/employees/${e.id}`)}>
        <div className="emp-kb-top">
          <StaffPhoto path={`/api/ops/hr/employees/${e.id}/photo`} hasPhoto={Boolean(e.hasPhoto)} name={fullName} size={46} round />
          <div style={{ minWidth: 0 }}>
            <p className="emp-kb-name">{fullName}</p>
            <p className="emp-kb-role">{String(e.position ?? 'No position')}</p>
            <span className="emp-kb-id">{String(e.employeeNo ?? e.employeeNumber ?? '')}</span>
          </div>
        </div>
        {(tags.length > 0) && (
          <div className="emp-tag-row">{tags.map((t, i) => <span key={i} className="emp-tag">{t}</span>)}</div>
        )}
        <div className="emp-kb-meta">
          {manager && <div className="emp-kb-row"><b>Manager</b><span>{manager}</span></div>}
          {String(e.locationName ?? '') && <div className="emp-kb-row"><b>Location</b><span>{String(e.locationName)}</span></div>}
          {String(e.workEmail ?? e.mobilePhone ?? '') && <div className="emp-kb-row"><b>Contact</b><span>{String(e.workEmail ?? e.mobilePhone ?? '')}</span></div>}
          {String(e.badgeId ?? '') && <div className="emp-kb-row"><b>Badge</b><span className="cell-mono">{String(e.badgeId)}</span></div>}
        </div>
        <div className="emp-kb-foot"><Badge value={e.status} /></div>
      </button>
    );
  };

  if (error) return <ErrorBanner error={error} />;
  if (!loaded) return <PageLoader variant="page" label="Loading directory…" />;
  const total = groups.reduce((n, g) => n + (Array.isArray(g.employees) ? g.employees.length : 0), 0) + ungrouped.length;
  return (
    <div>
      <div className="toolbar">
        <span className="muted">{total} people</span>
        {canCreate && <button className="btn btn-sm btn-primary" onClick={() => navigate('/people/employees/new')}>New employee</button>}
      </div>
      {groups.map((g) => (
        <section key={String(g.id)} className="emp-kb-group">
          <div className="emp-kb-group-head">
            <h2>{String(g.name)}</h2>
            <span className="emp-kb-count">{Array.isArray(g.employees) ? g.employees.length : 0}</span>
          </div>
          <div className="emp-kb-grid">{(Array.isArray(g.employees) ? g.employees : []).map(card)}</div>
        </section>
      ))}
      {ungrouped.length > 0 && (
        <section className="emp-kb-group">
          <div className="emp-kb-group-head"><h2>No department</h2><span className="emp-kb-count">{ungrouped.length}</span></div>
          <div className="emp-kb-grid">{ungrouped.map(card)}</div>
        </section>
      )}
      {total === 0 && <EmptyState icon="👥" title="No one on the directory" hint="Hire the first person to populate the directory." />}
    </div>
  );
}

// --- Private information (dependants, contacts, skills, …) ------------------

type FieldType = 'text' | 'date' | 'number' | 'select' | 'bool';

interface FieldDef { key: string; label: string; type: FieldType; options?: string[]; required?: boolean }
interface PrivateForm { kind: string; title: string; icon: string; fields: FieldDef[]; columns: string[] }

const PRIVATE_FORMS: PrivateForm[] = [
  {
    kind: 'dependants', title: 'Dependants', icon: '👨‍👩‍👧',
    columns: ['fullName', 'relationship', 'dob', 'isBeneficiary'],
    fields: [
      { key: 'fullName', label: 'Full name', type: 'text', required: true },
      { key: 'relationship', label: 'Relationship', type: 'select', options: ['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'] },
      { key: 'dob', label: 'Date of birth', type: 'date' },
      { key: 'gender', label: 'Gender', type: 'text' },
      { key: 'nationalId', label: 'National ID', type: 'text' },
      { key: 'isBeneficiary', label: 'Beneficiary', type: 'bool' },
    ],
  },
  {
    kind: 'emergencyContacts', title: 'Emergency contacts', icon: '🆘',
    columns: ['fullName', 'relationship', 'phone', 'isPrimary'],
    fields: [
      { key: 'fullName', label: 'Full name', type: 'text', required: true },
      { key: 'relationship', label: 'Relationship', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'address', label: 'Address', type: 'text' },
      { key: 'isPrimary', label: 'Primary contact', type: 'bool' },
    ],
  },
  {
    kind: 'skills', title: 'Skills', icon: '🧠',
    columns: ['skillName', 'proficiency', 'yearsExperience', 'lastUsedYear'],
    fields: [
      { key: 'skillName', label: 'Skill', type: 'text', required: true },
      { key: 'proficiency', label: 'Proficiency', type: 'select', options: ['BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'] },
      { key: 'yearsExperience', label: 'Years experience', type: 'number' },
      { key: 'lastUsedYear', label: 'Last used (year)', type: 'number' },
      { key: 'notes', label: 'Notes', type: 'text' },
    ],
  },
  {
    kind: 'qualifications', title: 'Education & qualifications', icon: '🎓',
    columns: ['qualificationName', 'qualificationType', 'institution', 'endDate'],
    fields: [
      { key: 'qualificationType', label: 'Type', type: 'select', options: ['DEGREE', 'DIPLOMA', 'CERTIFICATE', 'MASTERS', 'PHD', 'PROFESSIONAL', 'OTHER'] },
      { key: 'qualificationName', label: 'Qualification', type: 'text', required: true },
      { key: 'institution', label: 'Institution', type: 'text', required: true },
      { key: 'fieldOfStudy', label: 'Field of study', type: 'text' },
      { key: 'grade', label: 'Grade', type: 'text' },
      { key: 'startDate', label: 'Start', type: 'date' },
      { key: 'endDate', label: 'End', type: 'date' },
      { key: 'country', label: 'Country', type: 'text' },
    ],
  },
  {
    kind: 'certifications', title: 'Certifications', icon: '📜',
    columns: ['name', 'issuer', 'expiryDate', 'status'],
    fields: [
      { key: 'name', label: 'Certification', type: 'text', required: true },
      { key: 'issuer', label: 'Issuer', type: 'text' },
      { key: 'certNo', label: 'Cert no', type: 'text' },
      { key: 'issueDate', label: 'Issue date', type: 'date' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date' },
      { key: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'EXPIRED', 'REVOKED'] },
    ],
  },
  {
    kind: 'workHistory', title: 'Work history', icon: '💼',
    columns: ['employer', 'jobTitle', 'startDate', 'endDate'],
    fields: [
      { key: 'employer', label: 'Employer', type: 'text', required: true },
      { key: 'jobTitle', label: 'Job title', type: 'text' },
      { key: 'startDate', label: 'Start', type: 'date' },
      { key: 'endDate', label: 'End', type: 'date' },
      { key: 'salary', label: 'Salary', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'reasonForLeaving', label: 'Reason for leaving', type: 'text' },
      { key: 'isCurrent', label: 'Current role', type: 'bool' },
    ],
  },
];

function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  return s === '' ? '—' : s;
}

function PrivateSection({ employeeId, form, canEdit }: { employeeId: number; form: PrivateForm; canEdit: boolean }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [values, setValues] = useState<Rec>({});
  const [confirm, setConfirm] = useState<Rec | null>(null);

  const load = useCallback(() => {
    api<{ data: Record<string, Rec[]> }>(`/api/ops/hr/employees/${employeeId}/private`)
      .then((r) => setRows((r.data && r.data[form.kind]) ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
  }, [employeeId, form.kind]);
  useEffect(() => { load(); }, [load]);

  const open = (row: Rec | 'new') => {
    setEditing(row);
    setValues(row === 'new' ? {} : { ...row });
    setError('');
  };
  const setField = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const save = async () => {
    setBusy(true); setError('');
    try {
      const id = editing === 'new' ? null : Number((editing as Rec).id);
      await api(`/api/ops/hr/employees/${employeeId}/private/${form.kind}${id != null ? '/' + id : ''}`, {
        method: id != null ? 'PATCH' : 'POST',
        body: JSON.stringify(values),
      });
      setEditing(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm) return;
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${employeeId}/private/${form.kind}/${confirm.id}`, { method: 'DELETE' });
      setConfirm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{form.icon} {form.title}</h3>
        <div className="action-group">
          <span className="muted">{rows.length}</span>
          {canEdit && <button className="btn btn-sm btn-primary" onClick={() => open('new')}>Add</button>}
        </div>
      </div>
      {error && <div className="card-pad" style={{ paddingBottom: 0 }}><ErrorBanner error={error} /></div>}
      {rows.length === 0 ? (
        <div className="card-pad">
          <EmptyState icon={form.icon} title={`No ${form.title.toLowerCase()} on file`} hint={canEdit ? 'Add the first entry.' : undefined} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {form.columns.map((c) => <th key={c}>{form.fields.find((f) => f.key === c)?.label ?? c}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  {form.columns.map((c) => <td key={c}>{cell(r[c])}</td>)}
                  <td>
                    {canEdit && <div className="action-group"><button className="btn btn-sm" onClick={() => open(r)}>Edit</button><button className="btn btn-sm" onClick={() => setConfirm(r)}>Delete</button></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={`${editing === 'new' ? 'Add' : 'Edit'} ${form.title.replace(/s$/, '').toLowerCase()}`}
          onClose={() => setEditing(null)}
          footer={
            <div className="action-group">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save</button>
            </div>
          }
        >
          <div className="form-grid">
            {form.fields.map((f) => {
              const value = values[f.key];
              if (f.type === 'bool') {
                return (
                  <div className="field" key={f.key}>
                    <label>{f.label}</label>
                    <select value={value === true ? 'yes' : 'no'} onChange={(e) => setField(f.key, e.target.value === 'yes')}>
                      <option value="no">No</option>
                      <option value="yes">Yes</option>
                    </select>
                  </div>
                );
              }
              if (f.type === 'select') {
                return (
                  <div className="field" key={f.key}>
                    <label>{f.label}{f.required ? ' *' : ''}</label>
                    <select value={String(value ?? '')} onChange={(e) => setField(f.key, e.target.value)}>
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                );
              }
              const inputType = f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text';
              return (
                <div className="field" key={f.key}>
                  <label>{f.label}{f.required ? ' *' : ''}</label>
                  <input
                    type={inputType}
                    inputMode={f.type === 'number' ? 'decimal' : undefined}
                    value={String(value ?? '')}
                    onChange={(e) => setField(f.key, f.type === 'number' ? e.target.value : e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </Modal>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${form.title.replace(/s$/, '').toLowerCase()}`}
          body="This removes the record from the employee file."
          confirmLabel="Delete"
          danger
          reasonLabel={null}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  );
}

/** Private-information tab on the employee 360 desk. */
export function EmployeePrivate({ id }: { id: number }) {
  const { user } = useAuth();
  const canEdit = can(user, 'hr.employees.update');
  return (
    <div className="desk-panel stack">
      {PRIVATE_FORMS.map((f) => <PrivateSection key={f.kind} employeeId={id} form={f} canEdit={canEdit} />)}
    </div>
  );
}
