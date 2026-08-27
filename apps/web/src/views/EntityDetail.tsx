import { useCallback, useEffect, useState } from 'react';
import { api, EntityMeta, fmtBool, fmtDate, fmtMoney, fmtNum } from '../api';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { JsonForm } from '../components/JsonForm';
import { navigate, RouteMatch } from '../router';
import { moduleLabel, pick } from '../helpers';
import { useAuth, can } from '../auth';
import { ConfirmDialog } from '../components/os';
import { RecordNav, StickyActions } from '../components/nav';
import { allowedActions } from '../work';

interface AuditRow {
  id: number;
  action: string;
  resource: string;
  record_id?: number;
  record_code?: string | null;
  actor_name?: string | null;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  created_at?: string;
  [key: string]: unknown;
}

const HIDDEN_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'attributes', 'secret_hash',
  'tenant_id', 'company_id', 'branch_id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy',
  'tenantId', 'companyId', 'branchId', 'secretHash',
]);

function prettyLabel(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function detailSections(row: Record<string, unknown>): [string, string, unknown][] {
  const out: [string, string, unknown][] = [];
  for (const [k, v] of Object.entries(row)) {
    if (HIDDEN_FIELDS.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    out.push([k, prettyLabel(k), v]);
  }
  return out;
}

function formatDetail(name: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return fmtBool(value);
  if (/date|_at|time/i.test(name)) return fmtDate(value);
  if (/amount|total|subtotal|price|cost|value|balance|rate|limit/i.test(name) && (typeof value === 'number' || (typeof value === 'string' && /^-?\d/.test(value)))) {
    return fmtMoney(value);
  }
  if (typeof value === 'number') return fmtNum(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function EntityDetail({ route }: { route: RouteMatch }) {
  const module = route.segments[1];
  const resource = route.segments[2];
  const id = Number(route.segments[3]);
  const base = `/api/${module}/${resource}`;
  const { user } = useAuth();

  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [qrCodes, setQrCodes] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrCount, setQrCount] = useState(1);
  const [comment, setComment] = useState('');
  const [actBusy, setActBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('overview');
  const [confirm, setConfirm] = useState<{ id: string; title: string; body: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [m, rec, aud] = await Promise.all([
      api<{ data: EntityMeta }>(`/api/meta/entities/${module}/${resource}`),
      api<{ data: Record<string, unknown> }>(`${base}/${id}`),
      api<{ data: AuditRow[] }>(`${base}/${id}/audit`),
    ]);
    setMeta(m.data);
    setRow(rec.data);
    setAudit(aud.data);
    if (m.data.qrEntityType) {
      try {
        const p = await api<{ qrCodes: Record<string, unknown>[] }>(`${base}/${id}/print`, { method: 'POST' });
        setQrCodes(p.qrCodes ?? []);
      } catch { /* print not allowed for this user */ }
    }
  }, [base, id, module, resource]);

  useEffect(() => {
    loadAll()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load record'))
      ;
  }, [loadAll]);

  const doAction = async (action: string, payload?: Record<string, unknown>) => {
    setActBusy(true);
    setNotice('');
    setError('');
    try {
      await api(`${base}/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload ?? {}) });
      setNotice(`${action} performed`);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActBusy(false);
    }
  };

  const saveEdit = async (values: Record<string, unknown>) => {
    await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(values) });
    setEditOpen(false);
    await loadAll();
  };

  const generateQr = async () => {
    if (!meta?.qrEntityType) return;
    setActBusy(true);
    setError('');
    try {
      const r = await api<{ data: Array<{ code?: string }> }>('/api/qr/generate', {
        method: 'POST',
        body: JSON.stringify({ entityType: meta.qrEntityType, entityId: id, count: qrCount }),
      });
      const codes = (r.data ?? []).map((q) => q.code).filter((c): c is string => Boolean(c));
      setNotice(`Generated ${codes.length} QR code(s)`);
      setQrCodes((prev) => [...codes.map((c) => ({ code: c })), ...prev]);
      setQrOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActBusy(false);
    }
  };

  if (error && !row) return <ErrorBanner error={error} />;
  if (!meta || !row) return <PageLoader label="Loading record…" />;

  const status = pick<string>(row, meta.statusColumn ?? '', 'status') ?? null;
  const code = pick<string>(row, meta.codeColumn ?? '', 'id') ?? '';

  const actions = allowedActions(status, module, resource, (p) => can(user, p));
  const run = (id: string) => {
    if (id === 'edit') { setEditOpen(true); return; }
    if (id === 'void' || id === 'cancel') {
      setConfirm({ id, title: `${id === 'void' ? 'Void' : 'Cancel'} ${meta.label}?`, body: `${code} will leave the live pipeline. This writes an audit event and cannot be undone from this screen.` });
      return;
    }
    void doAction(id, id === 'approve' || id === 'reject' ? { comment } : undefined);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            {meta.label} <span className="cell-mono">{code}</span>
          </h1>
          <p className="muted">{moduleLabel(module)} · record {id}</p>
        </div>
        <div className="head-actions">
          {status && <Badge value={status} />}
          {actions.filter((a) => a.id !== 'edit').map((a) => (
            <button key={a.id} className={`btn ${a.tone === 'primary' ? 'btn-primary' : a.tone === 'success' ? 'btn-success' : a.tone === 'danger' ? 'btn-danger' : ''}`} disabled={actBusy} onClick={() => run(a.id)}>{a.label}</button>
          ))}
          {actions.some((a) => a.id === 'edit') && <button className="btn" onClick={() => setEditOpen(true)}>Edit</button>}
          {meta.qrEntityType && <button className="btn" onClick={() => setQrOpen(true)}>QR</button>}
        </div>
      </header>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}

      <RecordNav module={module} resource={resource} tab={tab} onTab={setTab} />

      {tab === 'overview' && <div className="detail-grid">
        <section className="card">
          <div className="card-head">
            <h3>Overview</h3>
            {status && <Badge value={status} />}
          </div>
          <dl className="detail-list">
            {detailSections(row).map(([k, label, v]) => (
              <div key={k} className="detail-row">
                <dt>{label}</dt>
                <dd className={k === meta.codeColumn ? 'cell-mono' : undefined}>{formatDetail(k, v)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>What happens next</h3></div>
            <div className="flow-actions">
              {actions.length === 0 && <p className="muted">No actions are available for this status and your clearance.</p>}
              {actions.some((a) => a.id === 'approve') && (
                <div className="field">
                  <span>Comment</span>
                  <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why you are deciding" />
                </div>
              )}
              {actions.filter((a) => !['edit'].includes(a.id)).map((a) => (
                <button key={a.id} className={`btn btn-block ${a.tone === 'primary' ? 'btn-primary' : a.tone === 'success' ? 'btn-success' : a.tone === 'danger' ? 'btn-danger' : ''}`} disabled={actBusy} onClick={() => run(a.id)}>{a.label}</button>
              ))}
            </div>
          </section>

          {qrCodes.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>QR Codes</h3></div>
              <div className="qr-list">
                {qrCodes.map((qr, i) => (
                  <button key={i} className="qr-chip" onClick={() => navigate(`/qr/${String(qr.code)}`)}>
                    <span className="cell-mono">{String(qr.code)}</span>
                    <Badge value={pick(qr, 'status')} />
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head"><h3>Traceability</h3></div>
            <div className="flow-actions">
              <button className="btn btn-block" onClick={() => navigate(`/inventory/items`)}>Stock</button>
              <button className="btn btn-block" onClick={() => navigate(`/inventory/movements`)}>Movements</button>
            </div>
          </section>
        </div>
      </div>}

      {tab === 'qr' && (
        <section className="card">
          <div className="card-head"><h3>QR identity</h3></div>
          <div className="qr-list">
            {qrCodes.length === 0 && <p className="muted" style={{ padding: 16 }}>No labels generated yet.</p>}
            {qrCodes.map((qr, i) => (
              <button key={i} className="qr-chip" onClick={() => navigate(`/qr/${String(qr.code)}`)}>
                <span className="cell-mono">{String(qr.code)}</span>
                <Badge value={pick(qr, 'status')} />
              </button>
            ))}
          </div>
          {meta.qrEntityType && <div className="flow-actions"><button className="btn btn-primary" onClick={() => setQrOpen(true)}>Generate labels</button></div>}
        </section>
      )}

      {(tab === 'timeline' || tab === 'audit') && <section className="card">
        <div className="card-head"><h3>Activity Timeline</h3></div>
        <div className="timeline">
          {audit.length === 0 && <p className="muted">No audit events yet.</p>}
          {audit.map((a) => {
            const oldV = a.old_values ?? a.oldValues;
            const newV = a.new_values ?? a.newValues;
            return (
              <div key={a.id} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-title">
                    <Badge value={a.action} /> <span className="muted">{a.actor_name ?? 'system'}</span>
                  </div>
                  <div className="timeline-meta">{fmtDate(pick(a, 'created_at', 'createdAt'))} | {a.resource} #{pick(a, 'record_id', 'recordId')}</div>
                  {Boolean(oldV || newV) && (
                    <div className="timeline-changes">
                      <code>{oldV ? JSON.stringify(oldV) : ''}</code>
                      <span>{'→'}</span>
                      <code>{newV ? JSON.stringify(newV) : ''}</code>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.id === 'void' ? 'Void document' : 'Cancel document'}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { setConfirm(null); void doAction(confirm.id, { comment: reason }); }}
        />
      )}

      {editOpen && (
        <Modal title={`Edit ${meta.label}`} onClose={() => setEditOpen(false)} wide>
          <JsonForm meta={meta} initial={row} onSubmit={saveEdit} onCancel={() => setEditOpen(false)} submitLabel="Save" />
        </Modal>
      )}

      <StickyActions>
        {actions.filter((a) => a.id !== 'edit').slice(0, 3).map((a) => (
          <button key={a.id} className={`btn ${a.tone === 'primary' ? 'btn-primary' : a.tone === 'success' ? 'btn-success' : a.tone === 'danger' ? 'btn-danger' : ''}`} disabled={actBusy} onClick={() => run(a.id)}>{a.label}</button>
        ))}
        <button className="btn" onClick={() => navigate(`/records/${module}/${resource}`)}>Back</button>
      </StickyActions>

      {qrOpen && meta.qrEntityType && (
        <Modal title="Generate QR Label" onClose={() => setQrOpen(false)}>
          <div className="field">
            <span>Entity type</span>
            <input disabled value={meta.qrEntityType} />
          </div>
          <div className="field">
            <span>Number of labels (1–100)</span>
            <input type="number" min={1} max={100} value={qrCount} onChange={(e) => setQrCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </div>
          <div className="field">
            <span>Example payload</span>
            <input disabled value={`HDG-${meta.qrEntityType}-${String(id).padStart(8, '0')}`} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setQrOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={actBusy} onClick={generateQr}>Generate</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
