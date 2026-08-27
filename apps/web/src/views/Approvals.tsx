import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { pick } from '../helpers';
import { navigate } from '../router';

interface ApprovalRow {
  task_id?: number;
  entity_type?: string;
  entity_id?: number;
  entity_code?: string | null;
  step_label?: string | null;
  submitted_at?: string;
  submitted_by?: string | null;
  amount?: number | null;
  company?: string | null;
  branch?: string | null;
  [key: string]: unknown;
}

export default function Approvals() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ data: ApprovalRow[] }>('/api/approvals');
    setRows(r.data);
  }, []);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load approvals')).finally(() => setBusy(false));
  }, [load]);

  const decide = async (row: ApprovalRow, decision: string) => {
    const taskId = Number(row.task_id ?? row.taskId);
    if (!taskId) return;
    setActingId(taskId);
    setError('');
    try {
      await api(`/api/approvals/${taskId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
      });
      setComment('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Approvals Queue</h1>
        <p className="muted">Tasks assigned to you or your roles. Decisions are SoD-checked and audited.</p>
      </header>
      {error && <ErrorBanner error={error} />}
      {busy ? (
        <PageLoader label="Loading approvals…" />
      ) : rows.length === 0 ? (
        <div className="card"><p className="muted">No pending approvals.</p></div>
      ) : (
        <div className="card">
          <div className="approval-table">
            <div className="approval-head">
              <span>Entity</span><span>Code</span><span>Step</span><span>Amount</span><span>Submitted</span><span>By</span><span>Action</span>
            </div>
            {rows.map((row) => {
              const entityType = String(pick(row, 'entity_type', 'entityType') ?? '');
              const entityId = Number(pick(row, 'entity_id', 'entityId') ?? 0);
              const taskId = Number(row.task_id ?? row.taskId);
              const module = entityType.split('.')[0] ?? '';
              const resource = entityType.split('.')[1] ?? '';
              return (
                <div className="approval-row" key={taskId}>
                  <span>{entityType.replace(/\./g, ' ')}</span>
                  <span className="cell-mono">{pick(row, 'entity_code', 'entityCode') ?? `#${entityId}`}</span>
                  <span><Badge value={pick(row, 'step_label', 'stepLabel')} /></span>
                  <span>{row.amount != null ? fmtMoney(row.amount) : '-'}</span>
                  <span>{fmtDate(pick(row, 'submitted_at', 'submittedAt'))}</span>
                  <span>{pick(row, 'submitted_by', 'submittedBy') ?? '-'}</span>
                  <span className="approval-actions">
                    <button className="btn btn-sm btn-success" disabled={actingId === taskId} onClick={() => decide(row, 'APPROVED')}>Approve</button>
                    <button className="btn btn-sm btn-danger" disabled={actingId === taskId} onClick={() => decide(row, 'REJECTED')}>Reject</button>
                    <button className="btn btn-sm" disabled={actingId === taskId} onClick={() => decide(row, 'RETURNED')}>Return</button>
                    {module && resource && (
                      <button className="btn btn-sm" onClick={() => navigate(`/records/${module}/${resource}/${entityId}`)}>Open</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <span>Comment (applies to next decision)</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional comment" />
          </div>
        </div>
      )}
    </div>
  );
}
