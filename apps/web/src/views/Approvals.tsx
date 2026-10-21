import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';
import ApprovalHistory, { type ApprovalHistoryRow } from './ApprovalHistory';

type Tab = 'pending' | 'history';

const HISTORY_FILTERS: { value: string; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'DELEGATED', label: 'Delegated' },
];

export default function Approvals() {
  const [tab, setTab] = useState<Tab>('pending');
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [history, setHistory] = useState<ApprovalHistoryRow[]>([]);
  const [historyFilter, setHistoryFilter] = useState('ALL');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const loadPending = useCallback(async () => {
    const r = await api<{ data: ApprovalRow[] }>('/api/approvals');
    setRows(r.data ?? []);
  }, []);

  const loadHistory = useCallback(async (status: string) => {
    const r = await api<{ data: ApprovalHistoryRow[] }>(
      `/api/approvals/history?status=${encodeURIComponent(status)}`
    );
    setHistory(r.data ?? []);
  }, []);

  useEffect(() => {
    setBusy(true);
    (tab === 'pending' ? loadPending() : loadHistory(historyFilter))
      .catch((err) => setError(err))
      .finally(() => setBusy(false));
  }, [tab, historyFilter, loadPending, loadHistory]);

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

  const selectFilter = (value: string) => {
    setHistoryFilter(value);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="exec">Approvals</p>
          <h1>Approvals queue</h1>
          <p className="muted">Approve or reject. Each decision is recorded against your name.</p>
        </div>
        {tab === 'pending' && rows.length > 0 && (
          <div className="queue-count"><b>{rows.length}</b> on your desk</div>
        )}
      </header>

      <div style={{ display: 'flex', gap: 8, margin: '0 0 12px' }}>
        <button
          className="btn btn-sm"
          style={tab === 'pending' ? { fontWeight: 700 } : undefined}
          onClick={() => setTab('pending')}
        >
          Pending
        </button>
        <button
          className="btn btn-sm"
          style={tab === 'history' ? { fontWeight: 700 } : undefined}
          onClick={() => setTab('history')}
        >
          History
        </button>
        {tab === 'history' && (
          <span style={{ display: 'flex', gap: 6, marginLeft: 8, alignItems: 'center' }}>
            {HISTORY_FILTERS.map((f) => (
              <button
                key={f.value}
                className="btn btn-sm"
                style={historyFilter === f.value ? { fontWeight: 700 } : undefined}
                onClick={() => selectFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {error ? <ErrorBanner error={error} /> : null}
      {busy ? (
        <PageLoader label={tab === 'pending' ? 'Loading approvals…' : 'Loading history…'} />
      ) : tab === 'pending' ? (
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
      ) : (
        <ApprovalHistory rows={history} />
      )}
    </div>
  );
}
