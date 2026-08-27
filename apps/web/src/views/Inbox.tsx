import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { pick } from '../helpers';
import { navigate } from '../router';
import { pathForEntity } from '../work';

interface ApprovalRow {
  [key: string]: unknown;
}

interface WorkFeed {
  exceptions: { code: string; label: string; count: number; href: string; severity: string }[];
  exceptionCount: number;
}

export default function Inbox() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [work, setWork] = useState<WorkFeed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [a, w] = await Promise.all([
      api<{ data: ApprovalRow[] }>('/api/approvals'),
      api<{ data: WorkFeed }>('/api/dashboard/work').catch(() => ({ data: { exceptions: [], exceptionCount: 0 } })),
    ]);
    setRows(a.data);
    setWork(w.data);
  }, []);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load inbox')).finally(() => setBusy(false));
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
        <div>
          <p className="muted" style={{ margin: 0, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 11, fontWeight: 700 }}>Inbox</p>
          <h1>What needs a human</h1>
          <p className="muted">Approvals are SoD-checked. Exceptions are live operational risk — not reports.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}

      {work && work.exceptions.length > 0 && (
        <div className="exception-list" style={{ marginBottom: 18 }}>
          {work.exceptions.map((ex) => (
            <button key={ex.code} className={`exception-item severity-${ex.severity}`} onClick={() => navigate(ex.href)}>
              <div>
                <strong>{ex.label}</strong>
                <div className="muted">{ex.severity} · open now</div>
              </div>
              <span className="ex-count">{ex.count}</span>
            </button>
          ))}
        </div>
      )}

      {busy ? (
        <PageLoader label="Loading inbox…" />
      ) : rows.length === 0 ? (
        <div className="card card-pad">
          <h3 style={{ marginTop: 0 }}>Decision queue is clear</h3>
          <p className="muted">Nothing is waiting on your role. Exceptions above still need floor action.</p>
        </div>
      ) : (
        <div className="card">
          <div className="card-head"><h3>Decisions</h3></div>
          <div className="approval-table">
            <div className="approval-head">
              <span>Work</span><span>Document</span><span>Step</span><span>Amount</span><span>When</span><span>From</span><span>Act</span>
            </div>
            {rows.map((row) => {
              const entityType = String(pick(row, 'entity_type', 'entityType') ?? '');
              const entityId = Number(pick(row, 'entity_id', 'entityId') ?? 0);
              const taskId = Number(row.task_id ?? row.taskId);
              return (
                <div className="approval-row" key={taskId}>
                  <span>{entityType.replace(/\./g, ' · ')}</span>
                  <span className="cell-mono">{String(pick(row, 'entity_code', 'entityCode') ?? `#${entityId}`)}</span>
                  <span><Badge value={pick(row, 'step_label', 'stepLabel')} /></span>
                  <span>{row.amount != null ? fmtMoney(row.amount) : '—'}</span>
                  <span>{fmtDate(pick(row, 'submitted_at', 'submittedAt'))}</span>
                  <span>{String(pick(row, 'submitted_by', 'submittedBy') ?? '—')}</span>
                  <span className="approval-actions">
                    <button className="btn btn-sm btn-success" disabled={actingId === taskId} onClick={() => decide(row, 'APPROVED')}>Approve</button>
                    <button className="btn btn-sm btn-danger" disabled={actingId === taskId} onClick={() => decide(row, 'REJECTED')}>Refuse</button>
                    <button className="btn btn-sm" disabled={actingId === taskId} onClick={() => decide(row, 'RETURNED')}>Return</button>
                    {entityType && (
                      <button className="btn btn-sm" onClick={() => navigate(pathForEntity(entityType, entityId))}>Open</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="field" style={{ padding: 12 }}>
            <span>Comment for the next decision</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why you approved, refused or returned" />
          </div>
        </div>
      )}
    </div>
  );
}
