import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import { navigate } from '../router';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';

interface WorkFeed {
  exceptions: { code: string; label: string; hint?: string; count: number; href: string; severity: string }[];
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
    <div className="page inbox-page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="exec">Inbox</p>
          <h1>Do this now</h1>
          <p className="muted">
            Approvals need a yes or no from you. The cards are work you can close today — tap one and finish it.
          </p>
        </div>
        {rows.length > 0 && (
          <div className="queue-count"><b>{rows.length}</b> to approve</div>
        )}
      </header>
      {error && <ErrorBanner error={error} />}

      {work && work.exceptions.length > 0 && (
        <div className="work-cards" style={{ marginBottom: 18 }}>
          {work.exceptions.map((ex) => (
            <button
              key={ex.code}
              type="button"
              className={`work-card severity-${ex.severity}`}
              onClick={() => navigate(ex.href)}
            >
              <span className="work-card-kicker">{ex.severity === 'critical' ? 'Urgent' : ex.severity === 'high' ? 'Do first' : 'Next'}</span>
              <strong>{ex.label}</strong>
              <span className="work-card-hint">{ex.hint ?? 'Open to finish'}</span>
              <span className="work-card-count">{ex.count}</span>
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
                <h3 style={{ marginTop: 0 }}>No approvals for your role</h3>
                <p className="muted">You are not an approver. Use the cards above if something still needs doing.</p>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>Nothing to approve</h3>
                <p className="muted">Your sign-off queue is empty. If cards are showing above, those still need you.</p>
              </>
            )
          }
        />
      )}
    </div>
  );
}

