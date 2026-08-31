import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';

export default function Approvals() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ data: ApprovalRow[] }>('/api/approvals');
    setRows(r.data ?? []);
  }, []);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load approvals')).finally(() => setBusy(false));
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
          <p className="muted">Tasks assigned to you or your roles. Decisions are SoD-checked and audited.</p>
        </div>
        {rows.length > 0 && (
          <div className="queue-count"><b>{rows.length}</b> on your desk</div>
        )}
      </header>
      {error && <ErrorBanner error={error} />}
      {busy ? (
        <PageLoader label="Loading approvals…" />
      ) : (
        <ApprovalQueue
          rows={rows}
          onDecide={decide}
          empty={
            <>
              <h3 style={{ marginTop: 0 }}>Decision queue is clear</h3>
              <p className="muted">Nothing is waiting on your role right now.</p>
            </>
          }
        />
      )}
    </div>
  );
}

