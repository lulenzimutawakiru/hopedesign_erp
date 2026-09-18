import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';

export default function Approvals() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ data: ApprovalRow[] }>('/api/approvals');
    setRows(r.data ?? []);
  }, []);

  useEffect(() => {
    setBusy(true);
    load()
      .catch((err) => setError(err))
      .finally(() => setBusy(false));
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
          <p className="mod-kicker" data-mod="exec">Approvals</p>
          <h1>Approvals queue</h1>
          <p className="muted">Approve or reject. Each decision is recorded against your name.</p>
        </div>
        {rows.length > 0 && (
          <div className="queue-count"><b>{rows.length}</b> on your desk</div>
        )}
      </header>
      {error ? <ErrorBanner error={error} /> : null}
      {busy ? (
        <PageLoader label="Loading approvals…" />
      ) : (
        <ApprovalQueue
          rows={rows}
          onDecide={decide}
          empty={
            <>
              <h3 style={{ marginTop: 0 }}>Nothing to approve</h3>
              <p className="muted">Your sign-off queue is empty.</p>
            </>
          }
        />
      )}
    </div>
  );
}

