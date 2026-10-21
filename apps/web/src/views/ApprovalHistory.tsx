import { fmtDate, fmtMoney } from '../api';
import { Badge } from '../components/ui';
import { pick } from '../helpers';
import { navigate } from '../router';
import { pathForEntity } from '../work';

export interface ApprovalHistoryRow {
  task_id?: number;
  instance_id?: number;
  entity_type?: string;
  entity_id?: number;
  entity_code?: string | null;
  workflow_name?: string | null;
  step_name?: string | null;
  step_seq?: number;
  status?: string;
  comment?: string | null;
  decided_at?: string;
  decided_by_name?: string | null;
  submitted_at?: string;
  submitted_by_name?: string | null;
  amount?: number | null;
  instance_status?: string | null;
  [key: string]: unknown;
}

const DECISION_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned',
  DELEGATED: 'Delegated',
};

function entityChip(entityType: string): string {
  const [module, resource] = entityType.split('.');
  if (module && resource) return `${module} · ${resource}`;
  return entityType || 'workflow';
}

/** Read-only record of the decisions the current user has already made. */
export default function ApprovalHistory({ rows }: { rows: ApprovalHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>No decisions yet</h3>
        <p className="muted">Your approval history will appear here.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>History</h3>
        <span className="queue-count">
          <b>{rows.length}</b> decisions
        </span>
      </div>
      <div className="queue">
        {rows.map((row) => {
          const entityType = String(pick(row, 'entity_type', 'entityType') ?? '');
          const entityId = Number(pick(row, 'entity_id', 'entityId') ?? 0);
          const href = entityType && entityId ? pathForEntity(entityType, entityId) : '';
          const decision = String(pick(row, 'status') ?? '');
          const amount = Number(pick(row, 'amount', 'total_amount', 'order_total'));
          const decidedAt = String(pick(row, 'decided_at', 'decidedAt') ?? '');
          const submittedBy = String(pick(row, 'submitted_by_name', 'submittedByName') ?? '');
          const stepName = pick(row, 'step_name', 'stepName', 'step_label', 'stepLabel');
          const stepLabel = stepName == null || stepName === '' ? 'Approval' : String(stepName);
          const workflowName = String(pick(row, 'workflow_name', 'workflowName') ?? '');
          const comment = pick(row, 'comment');

          return (
            <div className="queue-row" key={String(row.task_id ?? row.taskId ?? row.instance_id)}>
              <div className="queue-row-main">
                <span className="queue-row-title">
                  <span className="cell-mono">{String(pick(row, 'entity_code', 'entityCode') ?? `#${entityId}`)}</span>
                  <Badge value={DECISION_LABEL[decision] ?? decision} />
                  <Badge value={stepLabel} />
                  {workflowName && <span className="queue-row-workflow">{workflowName}</span>}
                </span>
                <span className="queue-row-meta">
                  <span>{entityChip(entityType)}</span>
                  {Number.isFinite(amount) && amount !== 0 && (
                    <>
                      <span className="sep">·</span>
                      <span>{fmtMoney(amount)}</span>
                    </>
                  )}
                  {submittedBy && (
                    <>
                      <span className="sep">·</span>
                      <span>{submittedBy}</span>
                    </>
                  )}
                  {decidedAt && (
                    <>
                      <span className="sep">·</span>
                      <span>Decided {fmtDate(decidedAt)}</span>
                    </>
                  )}
                  {comment != null && String(comment) !== '' && (
                    <>
                      <span className="sep">·</span>
                      <span className="muted">“{String(comment)}”</span>
                    </>
                  )}
                </span>
              </div>
              <div className="queue-row-side">
                {href && (
                  <button className="btn btn-sm" onClick={() => navigate(href)}>
                    Open
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
