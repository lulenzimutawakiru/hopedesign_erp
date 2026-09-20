/**
 * Company mail - approval queue.
 *
 * Every row here is a message the backend is holding because its mailbox or
 * classification requires approval. Segregation of duties is decided in
 * Postgres, not in the browser: `actionable` and `blockedReason` arrive on the
 * row, and a blocked step is returned rather than hidden so the requester can
 * see why nothing has happened yet. Those rows are rendered read-only - a
 * blocked decision is never offered as a button.
 *
 * `reject` and `return` require a written reason (the API answers 400 without
 * one), so those controls stay disabled until the approver types a note. An
 * approve may carry an optional note.
 *
 * The endpoint returns a bounded slice (`limit`), not a page object, so the
 * screen offers a server-side limit selector instead of a pager - it never
 * presents the returned slice as the whole queue.
 */
import { useEffect, useState } from 'react';
import { can, useAuth } from '../../auth';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import { approveApproval, rejectApproval, returnApproval } from './mailApi';
import { useMailApprovals, useMailboxes } from './useMail';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  MailHead,
  MailTabs,
  Nothing,
  RefreshBtn,
  SecCard,
  countText,
  modStyle,
  num,
  s,
  truncate,
  whenText,
} from './mailShared';
import { BlockedNote, ToneBadge } from './mailBits';
import { blockReasonText } from './mailDelivery';
import type { DeliveryTone } from './mailDelivery';
import type { PendingApprovalRow } from './mail.types';

const PATH = '/communication/mail/approvals';
const LIMIT_OPTIONS = [25, 50, 100, 200];

/** The status column is a workflow state, so it carries its own tone. */
function approvalTone(status: unknown): DeliveryTone {
  const key = s(status).toUpperCase();
  if (key === 'APPROVED') return 'badge-green';
  if (key === 'REJECTED') return 'badge-red';
  if (key === 'RETURNED') return 'badge-amber';
  if (key === 'CANCELLED') return 'badge-neutral';
  return 'badge-blue';
}

function stepText(row: PendingApprovalRow): string {
  const who = s(row.approverName) || (s(row.approverRole) ? 'Role ' + s(row.approverRole) : 'Any approver');
  const level = num(row.requiredLevel);
  return level > 0 ? who + ' (level ' + level + ')' : who;
}

export default function MailApprovals() {
  const { user } = useAuth();
  const params = useHashQuery();

  const [limit, setLimit] = useState<number>(() => num(params.get('limit')) || 100);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number>(0);

  const queue = useMailApprovals({ limit });
  const mailboxes = useMailboxes();

  const canApprove = can(user, 'communication.mail_approvals.approve');
  const canReject = can(user, 'communication.mail_approvals.reject');

  // The slice size lives in the URL so a reload keeps the same view.
  useEffect(() => {
    navigate(PATH, { replace: true, query: { limit: limit === 100 ? undefined : limit } });
  }, [limit]);

  const rows = queue.data?.approvals ?? [];
  const actionableCount = num(queue.data?.actionableCount);
  const blockedShown = rows.filter((row) => !row.actionable).length;

  function noteFor(id: number): string {
    return notes[id] ?? '';
  }

  function setNote(id: number, value: string) {
    setNotes((prev) => ({ ...prev, [id]: value }));
  }

  function mailboxLabel(id: number | null): string {
    if (id === null) return '';
    const found = (mailboxes.data ?? []).find((box) => num(box.id) === num(id));
    return found ? s(found.address) || s(found.displayName) : '';
  }

  async function decide(row: PendingApprovalRow, kind: 'approve' | 'reject' | 'return') {
    const note = noteFor(row.id).trim();
    // The backend refuses a bare reject/return; fail fast rather than round-trip.
    if (kind !== 'approve' && !note) return;
    if (busy) return;
    setBusy(row.id);
    try {
      if (kind === 'approve') await approveApproval(row.id, note || undefined);
      else if (kind === 'reject') await rejectApproval(row.id, note);
      else await returnApproval(row.id, note);
      setNote(row.id, '');
      queue.refresh();
      toast.success(
        kind === 'approve'
          ? 'Message approved and released to the outbox'
          : kind === 'reject'
            ? 'Message rejected'
            : 'Message returned to its author'
      );
    } catch (e) {
      toast.fromError('Could not record the decision', e);
    } finally {
      setBusy(0);
    }
  }

  if (queue.loading && !queue.data) return <PageLoader label="Loading the approval queue" />;

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title="Approvals"
        sub="Messages held for authorisation. A request you raised yourself cannot be decided by you, and an earlier step must clear before a later one can be decided."
        actions={<RefreshBtn onClick={queue.refresh} disabled={queue.loading} />}
      />
      <MailTabs active="approvals" />

      <ErrorBanner error={queue.error} />

      <KpiRow>
        <KpiTile
          label="Ready for your decision"
          value={countText(actionableCount)}
          sub="actionable now"
        />
        <KpiTile
          label="Blocked"
          value={countText(blockedShown)}
          sub="within the rows shown"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
        />
        <KpiTile
          label="Rows returned"
          value={countText(rows.length)}
          sub={'limit ' + limit}
          accent="#64748B"
          tint="rgba(100, 116, 139, 0.12)"
        />
      </KpiRow>

      <SecCard
        title="Pending decisions"
        sub="Approve releases the message; reject stops it; return sends it back to the author for changes. Reject and return both require a written reason."
        actions={
          <label className="field" style={{ margin: 0 }}>
            <span>Rows</span>
            <select
              className="hk-select"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="Rows to load"
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Mailbox</th>
                <th scope="col">Step</th>
                <th scope="col">Waiting since</th>
                <th scope="col">State</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow cols={6}>
                  <Nothing
                    text={queue.loading ? 'Loading the approval queue\u2026' : 'Nothing is waiting on a decision.'}
                    action={queue.loading ? undefined : 'Go to drafts'}
                    onAction={queue.loading ? undefined : () => navigate('/communication/mail/drafts')}
                  />
                </EmptyRow>
              ) : (
                rows.map((row) => {
                  const note = noteFor(row.id);
                  const working = busy === row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <a className="cell-main" href={'#/communication/mail/message/' + row.emailId}>
                          {truncate(row.emailSubject, 90) || '(no subject)'}
                        </a>
                        <div className="cell-sub">
                          {'Raised by ' + (s(row.requesterName) || 'unknown')}
                        </div>
                        {s(row.reason) ? <div className="cell-sub">{truncate(row.reason, 120)}</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{mailboxLabel(row.emailMailboxId) || '\u2014'}</div>
                        {s(row.emailFolder) ? <div className="cell-sub">{s(row.emailFolder)}</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{stepText(row)}</div>
                        {s(row.classification) ? (
                          <div className="cell-sub">{'Classification ' + s(row.classification)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="cell-main">{whenText(row.requestedAt)}</div>
                        {s(row.emailStatus) ? <div className="cell-sub">{s(row.emailStatus)}</div> : null}
                      </td>
                      <td>
                        <ToneBadge tone={approvalTone(row.status)} label={s(row.status) || 'Pending'} />
                      </td>
                      <td>
                        {row.actionable ? (
                          <div className="stack-row" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                            <input
                              className="hk-input"
                              style={{ minWidth: 170 }}
                              placeholder="Decision note"
                              value={note}
                              onChange={(e) => setNote(row.id, e.target.value)}
                              aria-label={
                                'Decision note for ' + (s(row.emailSubject) || 'approval request ' + row.id)
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={!canApprove || working}
                              onClick={() => void decide(row, 'approve')}
                            >
                              {working ? 'Working\u2026' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              disabled={!canReject || working || note.trim() === ''}
                              title={note.trim() === '' ? 'A reason is required to reject a message.' : undefined}
                              onClick={() => void decide(row, 'reject')}
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={!canReject || working || note.trim() === ''}
                              title={note.trim() === '' ? 'A note is required to return a message for changes.' : undefined}
                              onClick={() => void decide(row, 'return')}
                            >
                              Return
                            </button>
                          </div>
                        ) : (
                          <BlockedNote>{blockReasonText(row.blockedReason)}</BlockedNote>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </SecCard>
    </div>
  );
}
