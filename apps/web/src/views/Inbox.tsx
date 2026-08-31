import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import { navigate } from '../router';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';

interface WorkFeed {
  exceptions: { code: string; label: string; count: number; href: string; severity: string }[];
  exceptionCount: number;
}

export default function Inbox() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [work, setWork] = useState<WorkFeed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approvalsDenied, setApprovalsDenied] = useState(false);

  const load = useCallback(async () => {
    const workPromise = api<{ data: WorkFeed }>('/api/dashboard/work').catch(() => ({ data: { exceptions: [], exceptionCount: 0 } }));
    let rows: ApprovalRow[] = [];
    let denied = false;
    try {
      const a = await api<{ data: ApprovalRow[] }>('/api/approvals');
      rows = a.data ?? [];
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) denied = true;
      else throw e;
    }
    const w = await workPromise;
    setRows(rows);
    setApprovalsDenied(denied);
    setWork(w.data);
  }, []);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load inbox')).finally(() => setBusy(false));
  }, [load]);

  const decide = useCallback(
    async (row: ApprovalRow, decision: string, comment: string) => {
      const taskId = Number(row.task_id ?? row.taskId);
      if (!taskId) return;
      await api(`/api/approvals/${taskId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
      });
      await load();
    },
    [load]
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="exec">Inbox</p>
          <h1>What needs a human</h1>
          <p className="muted">Approvals are SoD-checked. Exceptions are live operational risk — not reports.</p>
        </div>
        {rows.length > 0 && (
          <div className="queue-count"><b>{rows.length}</b> waiting on your desk</div>
        )}
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
      ) : (
        <ApprovalQueue
          rows={rows}
          onDecide={decide}
          empty={
            approvalsDenied ? (
              <>
                <h3 style={{ marginTop: 0 }}>No approval queue for your role</h3>
                <p className="muted">Approvals are managed by your org's approvers - your role doesn't include approval decisions. Exceptions above still need floor action.</p>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>Decision queue is clear</h3>
                <p className="muted">Nothing is waiting on your role. Exceptions above still need floor action.</p>
              </>
            )
          }
        />
      )}
    </div>
  );
}

