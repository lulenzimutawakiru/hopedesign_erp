import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate } from '../api';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

interface LabelTemplate {
  id: number;
  code: string;
  name: string;
  kind: string;
  mmWidth: number | null;
  mmHeight: number | null;
  printerModel: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
  [key: string]: unknown;
}

const KINDS = [
  'REAM',
  'CARTON',
  'PRODUCT',
  'BATCH',
  'PALLET',
  'ASSET',
  'MACHINE',
  'BIN',
  'DELIVERY',
  'WORK_ORDER',
];

const PRINTER_MODELS = [
  { value: 'b1pro', label: 'Niimbot B1 Pro (300 dpi)' },
  { value: 'b1', label: 'Niimbot B1 (203 dpi)' },
  { value: 'b1se', label: 'Niimbot B1 SE (203 dpi)' },
  { value: 'b2pro', label: 'Niimbot B2 Pro (300 dpi)' },
  { value: 'd11h', label: 'Niimbot D11-H (300 dpi)' },
  { value: 'm2h', label: 'Niimbot M2-H (300 dpi)' },
  { value: 'd110', label: 'Niimbot D110 (203 dpi)' },
  { value: 'n1', label: 'Niimbot N1 (203 dpi)' },
];

const PX_PER_MM = 300 / 25.4;
const mmToPx = (mm: number | null | undefined) =>
  mm != null && Number.isFinite(Number(mm)) ? Math.round(Number(mm) * PX_PER_MM) : null;

interface FormState {
  code: string;
  name: string;
  kind: string;
  mmWidth: string;
  mmHeight: string;
  printerModel: string;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = {
  code: '',
  name: '',
  kind: 'REAM',
  mmWidth: '',
  mmHeight: '',
  printerModel: 'b1pro',
  isDefault: false,
};

export default function LabelVarieties() {
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('ALL');
  const [modal, setModal] = useState<{ mode: 'new' } | { mode: 'edit'; row: LabelTemplate } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api<{ data: LabelTemplate[] }>('/api/qr/labels/templates?activeOnly=true');
      setTemplates(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load label varieties');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(
    () => (kind === 'ALL' ? templates : templates.filter((t) => t.kind === kind)),
    [templates, kind]
  );

  const openNew = () => {
    setForm({ ...EMPTY_FORM });
    setSaveError('');
    setModal({ mode: 'new' });
  };

  const openEdit = (row: LabelTemplate) => {
    setForm({
      code: row.code,
      name: row.name,
      kind: row.kind,
      mmWidth: row.mmWidth != null ? String(row.mmWidth) : '',
      mmHeight: row.mmHeight != null ? String(row.mmHeight) : '',
      printerModel: row.printerModel ?? '',
      isDefault: row.isDefault,
    });
    setSaveError('');
    setModal({ mode: 'edit', row });
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        kind: form.kind,
        mmWidth: form.mmWidth.trim() ? Number(form.mmWidth) : null,
        mmHeight: form.mmHeight.trim() ? Number(form.mmHeight) : null,
        printerModel: form.printerModel.trim() || null,
        isDefault: form.isDefault,
      };
      if (modal?.mode === 'edit') {
        await api(`/api/qr/labels/templates/${modal.row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setMsg(`Updated ${body.code}`);
      } else {
        await api('/api/qr/labels/templates', { method: 'POST', body: JSON.stringify(body) });
        setMsg(`Created ${body.code}`);
      }
      setModal(null);
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (row: LabelTemplate) => {
    try {
      await api(`/api/qr/labels/templates/${row.id}/default`, { method: 'POST' });
      setMsg(`${row.code} is now the default ${row.kind} variety`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set default variety');
    }
  };

  const archive = async (row: LabelTemplate) => {
    if (!window.confirm(`Archive label variety ${row.code}? It will no longer be offered for new labels.`)) return;
    try {
      await api(`/api/qr/labels/templates/${row.id}`, { method: 'DELETE' });
      setMsg(`${row.code} archived`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive variety');
    }
  };

  if (loading) return <PageLoader label="Loading label varieties..." />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Label Varieties</h1>
          <p className="muted">
            Manage the physical label sizes used for ream and carton authenticity labels on Niimbot printers. Each
            variety has a size in mm, a target printer model and an optional default per kind.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openNew}>
          New variety
        </button>
      </header>

      {error && <ErrorBanner error={error} />}
      {msg && <div className="alert alert-success">{msg}</div>}

      <div className="chips" style={{ marginBottom: 12 }}>
        {['ALL', ...KINDS].map((k) => (
          <button
            key={k}
            type="button"
            className={`chip${kind === k ? ' is-online' : ''}`}
            onClick={() => setKind(k)}
          >
            {k === 'ALL' ? 'All' : k}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ padding: 16 }}>
            No {kind !== 'ALL' ? `${kind} ` : ''}label varieties yet. Create one to start printing.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>Kind</th>
                  <th>Size</th>
                  <th>Printer</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const w = mmToPx(t.mmWidth);
                  const h = mmToPx(t.mmHeight);
                  return (
                    <tr key={t.id}>
                      <td>
                        <b className="cell-mono">{t.code}</b>
                        <div className="muted">{t.name}</div>
                      </td>
                      <td><Badge value={t.kind} /></td>
                      <td>
                        {t.mmWidth != null && t.mmHeight != null ? (
                          <>
                            <b>{t.mmWidth} &times; {t.mmHeight} mm</b>
                            <div className="muted">
                              {w} &times; {h} px @300dpi
                            </div>
                          </>
                        ) : (
                          <span className="muted">Not set</span>
                        )}
                      </td>
                      <td className="cell-mono">{t.printerModel ?? '-'}</td>
                      <td>
                        {t.isDefault && <span className="badge badge-purple">Default</span>}{' '}
                        {t.isActive ? (
                          <span className="badge badge-green">Active</span>
                        ) : (
                          <span className="badge badge-neutral">Archived</span>
                        )}
                      </td>
                      <td>{fmtDate(t.createdAt)}</td>
                      <td>
                        <div className="flow-actions">
                          <button type="button" className="btn btn-sm" onClick={() => openEdit(t)}>
                            Edit
                          </button>
                          {!t.isDefault && t.isActive && (
                            <button type="button" className="btn btn-sm" onClick={() => void setDefault(t)}>
                              Set default
                            </button>
                          )}
                          {t.isActive && (
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => void archive(t)}>
                              Archive
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'edit' ? `Edit ${modal.row.code}` : 'New label variety'}
          onClose={() => setModal(null)}
          footer={
            <div className="flow-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving...' : modal.mode === 'edit' ? 'Save changes' : 'Create variety'}
              </button>
            </div>
          }
        >
          {saveError && <ErrorBanner error={saveError} />}
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="field">
              <span>Code</span>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="LT-REAM-40x25"
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ream label 40x25mm"
              />
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Printer model</span>
              <select
                value={form.printerModel}
                onChange={(e) => setForm({ ...form, printerModel: e.target.value })}
              >
                <option value="">-</option>
                {PRINTER_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Width (mm)</span>
              <input
                type="number"
                min={1}
                max={400}
                step={0.5}
                value={form.mmWidth}
                onChange={(e) => setForm({ ...form, mmWidth: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Height (mm)</span>
              <input
                type="number"
                min={1}
                max={400}
                step={0.5}
                value={form.mmHeight}
                onChange={(e) => setForm({ ...form, mmHeight: e.target.value })}
              />
            </label>
          </div>
          {form.mmWidth && form.mmHeight && (
            <p className="muted" style={{ marginTop: 10 }}>
              Print size: {form.mmWidth} &times; {form.mmHeight} mm &rarr; {mmToPx(Number(form.mmWidth))} &times;{' '}
              {mmToPx(Number(form.mmHeight))} px @300dpi
            </p>
          )}
          <label className="check" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />
            Default variety for this kind (used when no variety is chosen)
          </label>
        </Modal>
      )}
    </div>
  );
}
