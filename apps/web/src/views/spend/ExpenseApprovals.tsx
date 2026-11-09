import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ErrorBanner, PageLoader } from '../../components/ui';
import ApprovalQueue, { type ApprovalRow } from '../ApprovalQueue';
import { SpendShell } from './kit';

/**
 * Dedicated approver board for the expenditure module. It reuses the same
 * workflow queue as the global inbox, filtered to the four expenditure entity
 * types, so decisions here and in the inbox are always the same sign-off.
 */
const EXPENDITURE_ENTITIES = new Set([
  'ops.expenses',
  'ops.claims',
  'ops.replenishments',
  'ops.daily_closings',
]);

export default function ExpenseApprovals() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const loadPending = useCallback(async () => {
    const r = await api<{ data: ApprovalRow[] }>('/api/approvals');
    setRows(
      (r.data ?? []).filter((row) =>
        EXPENDITURE_ENTITIES.has(String(row.entity_type ?? row.entityType ?? ''))
      )
    );
  }, []);

  useEffect(() => {
    setBusy(true);
    loadPending()
      .catch((err) => setError(err))
      .finally(() => setBusy(false));
  }, [loadPending]);

  const decide = useCallback(
    async (row: ApprovalRow, decision: string, comment: string) => {
      const taskId = Number(row.task_id ?? row.taskId);
      if (!taskId) return;
      await api(`/api/approvals/${taskId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
      });
      await loadPending();
    },
    [loadPending]
  );

  const bulkDecide = useCallback(
    async (batch: ApprovalRow[], decision: string, comment: string) => {
      const results = await Promise.allSettled(
        batch.map((row) => {
          const taskId = Number(row.task_id ?? row.taskId);
          return api(`/api/approvals/${taskId}/decide`, {
            method: 'POST',
            body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
          });
        })
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      await loadPending();
      if (failed > 0) {
        throw new Error(`${failed} of ${batch.length} approvals failed — review the queue before retrying.`);
      }
    },
    [loadPending]
  );

  return (
    <SpendShell
      title="Expense Management"
      blurb="Approve expenses, claims, petty-cash replenishments and daily closings from one board."
      active="approvals"
    >
      {error ? <ErrorBanner error={error} /> : null}
      {busy ? (
        <PageLoader label="Loading approvals…" />
      ) : (
        <ApprovalQueue
          rows={rows}
          onDecide={decide}
          onBulkDecide={bulkDecide}
          empty={
            <>
              <h3 style={{ marginTop: 0 }}>Nothing to approve</h3>
              <p className="muted">No expenditure items are waiting for your sign-off.</p>
            </>
          }
        />
      )}
    </SpendShell>
  );
}
