import { useState, type ReactNode } from 'react';
import { fmtDate, fmtMoney } from '../api';
import { Badge, ErrorBanner } from '../components/ui';
import { pick } from '../helpers';
import { navigate } from '../router';
import { pathForEntity } from '../work';

export interface ApprovalRow {
  task_id?: number;
  instance_id?: number;
  entity_type?: string;
  entity_id?: number;
  entity_code?: string | null;
  workflow_name?: string | null;
  step_name?: string | null;
  step_seq?: number;
  submitted_at?: string;
  submitted_by?: string | null;
  created_by?: number | null;
  approver_user_id?: number | null;
  due_at?: string | null;
  status?: string | null;
  amount?: number | null;
  company?: string | null;
  branch?: string | null;
  /** Acting-under-delegation context; present only when the task is decidable via an active delegation. */
  acting_role_code?: string | null;
  acting_role_name?: string | null;
  delegator_name?: string | null;
  delegation_code?: string | null;
  delegation_id?: number | null;
  /** False when the API would refuse a decision right now. Absent means decidable. */
  actionable?: boolean;
  /** Why the row cannot be decided yet: an earlier stage is open, or SoD. */
  blocked_reason?: string | null;
  [key: string]: unknown;
}

type DueState = { kind: 'overdue' | 'soon' | 'ok'; text: string } | null;

const DAY = 86_400_000;

function dueState(dueAt: unknown): DueState {
  if (dueAt == null) return null;
  const t = new Date(String(dueAt)).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  const text = `Due ${fmtDate(dueAt)}`;
  if (ms < 0) return { kind: 'overdue', text: `Overdue · ${text}` };
  if (ms < 2 * DAY) return { kind: 'soon', text: text };
  return { kind: 'ok', text };
}

function entityChip(entityType: string): string {
  const [module, resource] = entityType.split('.');
  if (module && resource) return `${module} · ${resource}`;
  return entityType || 'workflow';
}

/**
 * Plain-language reason a row cannot be decided yet. startWorkflow opens every
 * stage at submission, so a later-stage holder sees rows the API will refuse
 * until the earlier stage closes. The row stays visible; the reason stays
 * visible too, so nobody is left guessing why the buttons are inert.
 */
function blockedLabel(reason: string | null): string {
  if (reason === 'EARLIER_STEP_PENDING') return 'Waiting on an earlier step';
  if (reason === 'ALREADY_DECIDED_EARLIER_STEP') return 'You already decided an earlier step';
  return 'Not ready for you to decide';
}

interface Props {
  rows: ApprovalRow[];
  /** Custom empty-state body rendered when the queue is clear. */
  empty?: ReactNode;
  onDecide: (row: ApprovalRow, decision: string, comment: string) => Promise<void>;
  /** Batch decision path; when omitted the bulk-select controls are hidden. */
  onBulkDecide?: (rows: ApprovalRow[], decision: string, comment: string) => Promise<void>;
}

export default function ApprovalQueue({ rows, empty, onDecide, onBulkDecide }: Props) {
  const [commentByTask, setCommentByTask] = useState<Record<number, string>>({});
  const [noteOpen, setNoteOpen] = useState<Record<number, boolean>>({});
  const [actingId, setActingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [bulkArmed, setBulkArmed] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const overdueCount = rows.filter((r) => dueState(pick(r, 'due_at', 'dueAt'))?.kind === 'overdue').length;
  const soonCount = rows.filter((r) => dueState(pick(r, 'due_at', 'dueAt'))?.kind === 'soon').length;
  const blockedCount = rows.filter((r) => pick(r, 'actionable') === false).length;

  const decide = async (row: ApprovalRow, decision: string) => {
    const taskId = Number(row.task_id ?? row.taskId);
    if (!taskId) return;
    if (pick(row, 'actionable') === false) return;
    setActingId(taskId);
    setError('');
    try {
      const comment = (commentByTask[taskId] ?? '').trim();
      await onDecide(row, decision, comment);
      setCommentByTask((m) => ({ ...m, [taskId]: '' }));
      setNoteOpen((m) => ({ ...m, [taskId]: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  };

  // Bulk approve operates only on rows the API would actually let the user
  // decide now; blocked rows (earlier step open, SoD) are never selectable, so a
  // one-click batch action can't fire a decision the server would refuse.
  const actionableRows = rows.filter((r) => {
    const id = Number(r.task_id ?? r.taskId);
    return id > 0 && pick(r, 'actionable') !== false;
  });
  const selectedIds = actionableRows
    .filter((r) => selected[Number(r.task_id ?? r.taskId)])
    .map((r) => Number(r.task_id ?? r.taskId));
  const allSelected = actionableRows.length > 0 && selectedIds.length === actionableRows.length;

  const toggleSelect = (taskId: number) => setSelected((m) => ({ ...m, [taskId]: !m[taskId] }));
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<number, boolean> = {};
    for (const r of actionableRows) next[Number(r.task_id ?? r.taskId)] = true;
    setSelected(next);
  };
  const clearSelection = () => {
    setSelected({});
    setBulkArmed(false);
  };

  const bulkApprove = async () => {
    if (!onBulkDecide) return;
    const targets = actionableRows.filter((r) => selected[Number(r.task_id ?? r.taskId)]);
    if (targets.length === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      await onBulkDecide(targets, 'APPROVED', '');
      clearSelection();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="card card-pad">
        {empty ?? (
          <>
            <h3 style={{ marginTop: 0 }}>Nothing to approve</h3>
            <p className="muted">Your sign-off queue is empty.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Decisions</h3>
        <span className="queue-count">
          <b>{rows.length}</b> waiting
          {overdueCount > 0 && <span className="due-chip crit">{overdueCount} overdue</span>}
          {soonCount > 0 && <span className="due-chip warn">{soonCount} due soon</span>}
          {blockedCount > 0 && <span className="due-chip hold">{blockedCount} waiting on earlier steps</span>}
        </span>
      </div>
      {onBulkDecide && actionableRows.length > 0 && (
        <div className="queue-bulk">
          <label className="queue-bulk-select">
            <input
              type="checkbox"
              aria-label="Select all actionable"
              checked={allSelected}
              onChange={toggleSelectAll}
            />
            <span>{allSelected ? 'Deselect all' : 'Select all'}</span>
          </label>
          {selectedIds.length > 0 && !bulkArmed && (
            <button className="btn btn-sm btn-success" disabled={bulkBusy} onClick={() => setBulkArmed(true)}>
              Approve {selectedIds.length}
            </button>
          )}
          {selectedIds.length > 0 && bulkArmed && (
            <>
              <span className="muted">Approve {selectedIds.length} selected?</span>
              <button className="btn btn-sm btn-success" disabled={bulkBusy} onClick={bulkApprove}>
                {bulkBusy ? 'Approving…' : 'Confirm'}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={bulkBusy} onClick={() => setBulkArmed(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div style={{ margin: '8px 14px 0' }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <div className="queue">
        {rows.map((row) => {
          const entityType = String(pick(row, 'entity_type', 'entityType') ?? '');
          const entityId = Number(pick(row, 'entity_id', 'entityId') ?? 0);
          const taskId = Number(row.task_id ?? row.taskId);
          const href = entityType && entityId ? pathForEntity(entityType, entityId) : '';
          const stepRaw = pick(row, 'step_name', 'stepName', 'step_label', 'stepLabel');
          const stepLabel = stepRaw == null || stepRaw === '' ? 'Approval' : String(stepRaw);
          const workflowRaw = pick(row, 'workflow_name', 'workflowName');
          const workflowName = workflowRaw == null ? '' : String(workflowRaw);
          const submittedAtRaw = pick(row, 'submitted_at', 'submittedAt');
          const submittedAt = submittedAtRaw == null ? '' : String(submittedAtRaw);
          const submittedByRaw = pick(row, 'submitted_by', 'submittedBy');
          const submittedBy = submittedByRaw == null ? '' : String(submittedByRaw);
          const amount = Number(pick(row, 'amount', 'total_amount', 'order_total'));
          const due = dueState(pick(row, 'due_at', 'dueAt'));
          const comment = commentByTask[taskId] ?? '';
          const noteIsOpen = !!noteOpen[taskId];
          const blockedRaw = pick<string>(row, 'blocked_reason', 'blockedReason');
          const actionable = pick(row, 'actionable') !== false;
          const blockedText = actionable ? '' : blockedLabel(blockedRaw == null ? null : String(blockedRaw));
          const busyRow = actingId === taskId;
          const isEscalated = String(pick(row, 'status') ?? '') === 'ESCALATED';
          const actingRoleRaw = pick(row, 'acting_role_name', 'actingRoleName');
          const delegatorRaw = pick(row, 'delegator_name', 'delegatorName');
          const delegationCodeRaw = pick(row, 'delegation_code', 'delegationCode');
          const actingRoleName = actingRoleRaw == null ? '' : String(actingRoleRaw);
          const delegatorName = delegatorRaw == null ? '' : String(delegatorRaw);
          const isActing = actingRoleName !== '';

          return (
            <div
              className={`queue-row${onBulkDecide ? ' queue-row--bulk' : ''}${due?.kind === 'overdue' ? ' overdue' : ''}${due?.kind === 'soon' ? ' due-soon' : ''}${actionable ? '' : ' queue-row-blocked'}`}
              key={taskId}
            >
              {onBulkDecide && (
                <label className="queue-row-check">
                  <input
                    type="checkbox"
                    aria-label={`Select ${String(pick(row, 'entity_code', 'entityCode') ?? `#${entityId}`)}`}
                    checked={!!selected[taskId]}
                    disabled={!actionable}
                    onChange={() => toggleSelect(taskId)}
                  />
                </label>
              )}
              <div className="queue-row-main">
                <span className="queue-row-title">
                  <span className="cell-mono">{String(pick(row, 'entity_code', 'entityCode') ?? `#${entityId}`)}</span>
                  <Badge value={stepLabel} />
                  {workflowName && <span className="queue-row-workflow">{workflowName}</span>}
                  {isEscalated && (
                    <span className="queue-escalated-chip" title="This task is past its SLA and has been auto-escalated">
                      Escalated
                    </span>
                  )}
                  {isActing && (
                    <span
                      className="queue-acting-chip"
                      title={`Acting as ${actingRoleName}${delegationCodeRaw ? ` (${String(delegationCodeRaw)})` : ''}${delegatorName ? ` on behalf of ${delegatorName}` : ''}`}
                    >
                      Acting as {actingRoleName}
                      {delegatorName ? ` · for ${delegatorName}` : ''}
                    </span>
                  )}
                  {blockedText && (
                    <span className="queue-blocked-chip" title={blockedText}>
                      {blockedText}
                    </span>
                  )}
                </span>
                <span className="queue-row-meta">
                  <span>{entityChip(entityType)}</span>
                  {Number.isFinite(amount) && amount !== 0 && (
                    <>
                      <span className="sep">·</span>
                      <span>{fmtMoney(amount)}</span>
                    </>
                  )}
                  {submittedAt && (
                    <>
                      <span className="sep">·</span>
                      <span>Submitted {fmtDate(submittedAt)}</span>
                    </>
                  )}
                  {submittedBy && (
                    <>
                      <span className="sep">·</span>
                      <span>{String(submittedBy)}</span>
                    </>
                  )}
                  {due && (
                    <>
                      <span className="sep">·</span>
                      <span className={`due ${due.kind}`}>{due.text}</span>
                    </>
                  )}
                </span>
                {noteIsOpen && (
                  <span className="queue-note">
                    <input
                      autoFocus
                      aria-label="Decision note"
                      value={comment}
                      onChange={(e) => setCommentByTask((m) => ({ ...m, [taskId]: e.target.value }))}
                      onKeyDown={(e) => {
                        // Enter only dismisses the note editor — it must never decide.
                        // Approving on Enter turned a reflex keystroke into a binding
                        // sign-off, so the decision stays gated behind the explicit
                        // Approve / Return / Reject buttons.
                        if (e.key === 'Enter') setNoteOpen((m) => ({ ...m, [taskId]: false }));
                      }}
                      placeholder="Note for this decision"
                    />
                  </span>
                )}
              </div>
              <div className="queue-row-side">
                <span className="queue-actions">
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busyRow || !actionable}
                    onClick={() => setNoteOpen((m) => ({ ...m, [taskId]: !noteIsOpen }))}
                    title={actionable ? 'Add a note' : blockedText}
                  >
                    ✎
                  </button>
                  <button
                    className="btn btn-sm btn-success"
                    disabled={busyRow || !actionable}
                    title={actionable ? undefined : blockedText}
                    onClick={() => decide(row, 'APPROVED')}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={busyRow || !actionable}
                    title={actionable ? undefined : blockedText}
                    onClick={() => decide(row, 'RETURNED')}
                  >
                    Return
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busyRow || !actionable}
                    title={actionable ? undefined : blockedText}
                    onClick={() => decide(row, 'REJECTED')}
                  >
                    Reject
                  </button>
                  {href && (
                    <button className="btn btn-sm" onClick={() => navigate(href)}>
                      Open
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
