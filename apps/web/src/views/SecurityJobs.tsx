import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { pick } from '../helpers';

interface SecJob {
  id: number;
  job_no?: string;
  customer_name?: string | null;
  classification?: string | null;
  status?: string;
  job_type?: string | null;
  quantity?: number | null;
  product_name?: string | null;
  due_date?: string | null;
  [key: string]: unknown;
}

interface SecDetail {
  job?: Record<string, unknown>;
  requirements?: Record<string, unknown>[];
  operators?: Record<string, unknown>[];
  machines?: Record<string, unknown>[];
  batches?: Record<string, unknown>[];
  custodyEvents?: Record<string, unknown>[];
  [key: string]: unknown;
}

const FIELDS = [
  { key: 'customerId', label: 'Customer ID', required: true },
  { key: 'jobType', label: 'Job type', required: true },
  { key: 'description', label: 'Description', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'productId', label: 'Product ID', required: false },
  { key: 'dueDate', label: 'Due date', required: false },
  { key: 'classification', label: 'Classification', required: false },
];

export default function SecurityJobs() {
  const [jobs, setJobs] = useState<SecJob[]>([]);
  const [selected, setSelected] = useState<SecJob | null>(null);
  const [detail, setDetail] = useState<SecDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const loadJobs = useCallback(async () => {
    const r = await api<{ data: SecJob[] }>('/api/ops/security/jobs');
    setJobs(r.data);
  }, []);

  useEffect(() => {
    setBusy(true);
    loadJobs().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load security jobs')).finally(() => setBusy(false));
  }, [loadJobs]);

  const openDetail = async (job: SecJob) => {
    setSelected(job);
    setError('');
    try {
      const r = await api<{ data: SecDetail }>(`/api/ops/security/jobs/${job.id}/detail`);
      setDetail(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(null);
    }
  };

  const act = async (action: string, payload?: Record<string, unknown>) => {
    if (!selected) return;
    setError('');
    setNotice('');
    try {
      const r = await api<{ data: SecDetail }>(`/api/ops/security/jobs/${selected.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      });
      setNotice(`${action} completed`);
      await loadJobs();
      if (r.data) setDetail(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const createJob = async () => {
    const payload: Record<string, unknown> = {};
    for (const f of FIELDS) {
      const v = form[f.key]?.trim();
      if (!v && f.required) {
        setError(`${f.label} is required`);
        return;
      }
      if (v) {
        payload[f.key] = f.key === 'customerId' || f.key === 'productId' || f.key === 'quantity' ? Number(v) : v;
      }
    }
    setError('');
    try {
      const r = await api<{ data: { id: number } }>('/api/ops/security/jobs', { method: 'POST', body: JSON.stringify(payload) });
      setShowCreate(false);
      setForm({});
      await loadJobs();
      const created = jobs.find((j) => j.id === r.data.id) ?? { id: r.data.id } as SecJob;
      setSelected(created);
      await openDetail(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sec">Secure print</p>
          <h1>Security control room</h1>
          <p className="muted">Custody, dual control, spoilage and reconciliation. Sensitive actions always confirm.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Secure Job</button>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading secure jobs…" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Job No</th><th>Customer</th><th>Type</th><th>Classification</th><th>Qty</th><th>Due</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="row-click" onClick={() => openDetail(j)}>
                  <td className="cell-mono">{pick(j, 'job_no', 'jobNo') ?? `#${j.id}`}</td>
                  <td>{pick(j, 'customer_name', 'customerName') ?? '-'}</td>
                  <td>{pick(j, 'job_type', 'jobType') ?? '-'}</td>
                  <td><Badge value={j.classification} /></td>
                  <td>{j.quantity != null ? fmtNum(j.quantity) : '-'}</td>
                  <td>{fmtDate(pick(j, 'due_date', 'dueDate'))}</td>
                  <td><Badge value={j.status} /></td>
                  <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openDetail(j); }}>Open</button></td>
                </tr>
              ))}
              {jobs.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No security jobs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {selected && detail && (
        <Modal title={`Secure Job ${pick(selected, 'job_no', 'jobNo') ?? `#${selected.id}`}`} onClose={() => setSelected(null)} wide>
          <div className="detail-grid">
            <div>
              <dl className="detail-list">
                {Object.entries(detail.job ?? {}).filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k)).map(([k, v]) => (
                  <div className="detail-row" key={k}>
                    <dt>{k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</dt>
                    <dd>{v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="flow-actions">
              <button className="btn btn-primary btn-block" onClick={() => act('submit')}>Submit for approval</button>
              <button className="btn btn-block" onClick={() => act('issue-materials', { operatorId: undefined })}>Issue materials</button>
              <button className="btn btn-block" onClick={() => act('assign-machine', { machineId: 1 })}>Assign machine</button>
              <button className="btn btn-block" onClick={() => act('start')}>Start production</button>
              <button className="btn btn-block" onClick={() => act('complete', { quantityGood: Number(prompt('Good quantity') || 0), productId: Number(prompt('Product ID') || 0) })}>Complete</button>
              <button className="btn btn-block" onClick={() => act('qc', { result: 'PASSED' })}>QC pass</button>
              <button className="btn btn-block" onClick={() => act('package')}>Package</button>
              <button className="btn btn-block" onClick={() => act('storage')}>Secure storage</button>
              <button className="btn btn-block" onClick={() => act('dispatch')}>Dispatch</button>
              <button className="btn btn-block" onClick={() => act('deliver')}>Deliver</button>
            </div>
          </div>
          {(detail.custodyEvents?.length ?? 0) > 0 && (
            <div className="timeline" style={{ marginTop: 16 }}>
              {detail.custodyEvents!.map((ev, i) => (
                <div className="timeline-item" key={i}>
                  <div className="timeline-dot" />
                  <div className="timeline-body">
                    <div className="timeline-title"><Badge value={pick(ev, 'event_type', 'eventType')} /> <span className="muted">{pick(ev, 'actor_name', 'actorName') ?? ''}</span></div>
                    <div className="timeline-meta">{fmtDate(pick(ev, 'occurred_at', 'occurredAt'))}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {showCreate && (
        <Modal title="New Secure Job" onClose={() => setShowCreate(false)}>
          {FIELDS.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}{f.required ? ' *' : ''}</span>
              <input value={form[f.key] ?? ''} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} />
            </label>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createJob}>Create job</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
