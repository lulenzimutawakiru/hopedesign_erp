import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, Modal, Pager, Spinner } from '../../components/ui';
import { Field, Inp, Sel, Txa } from '../hikvision/fields';
import { qs } from '../hikvision/hkutil';
import {
  ActivityFeed,
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  dash,
  fmtAgo,
  fmtDT,
  fmtDay,
  label,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  sdPatch,
  sdPost,
  type Rec,
} from '../serviceDeskShared';

/* ------------------------------------------------------------------ *
 * Change management (spec 19)
 *
 * CHANGE REQUEST -> RISK ASSESSMENT -> IMPACT ANALYSIS -> APPROVAL ->
 * IMPLEMENTATION -> VALIDATION -> CLOSURE
 *
 * Normal, standard and emergency changes share a single pipeline. An
 * emergency change may be implemented before it is ratified, so it carries a
 * retrospective approval step that blocks closure until it is recorded.
 * ------------------------------------------------------------------ */

const CHANGE_STATUS_TONE: Record<string, string> = {
  DRAFT: 'draft',
  RISK_ASSESSMENT: 'review',
  IMPACT_ANALYSIS: 'review',
  PENDING_APPROVAL: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  IMPLEMENTATION: 'progress',
  VALIDATION: 'progress',
  CLOSED: 'closed',
  FAILED: 'failed',
  ROLLED_BACK: 'cancelled',
  CANCELLED: 'cancelled',
};

const CHANGE_TYPE_TONE: Record<string, string> = {
  NORMAL: 'normal',
  STANDARD: 'standard',
  EMERGENCY: 'critical',
};

const CHANGE_RISK_TONE: Record<string, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const APPROVAL_STATUS_TONE: Record<string, string> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELEGATED: 'delegated',
  SKIPPED: 'skipped',
};

const APPROVAL_TYPE_LABEL: Record<string, string> = {
  RISK: 'Risk assessment',
  CAB: 'Change advisory board',
  IMPLEMENTATION: 'Implementation authorisation',
  RETROSPECTIVE: 'Retrospective ratification',
  EMERGENCY: 'Emergency authorisation',
};

/** The stage strip on the change record. Colour is never the only signal. */
const CHANGE_FLOW = [
  'DRAFT',
  'RISK_ASSESSMENT',
  'IMPACT_ANALYSIS',
  'PENDING_APPROVAL',
  'APPROVED',
  'IMPLEMENTATION',
  'VALIDATION',
  'CLOSED',
];

const CHANGE_SORTS: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'planned', label: 'Planned start' },
  { value: 'risk', label: 'Highest risk' },
  { value: 'number', label: 'Change number' },
];

/* ------------------------------------------------------------------ *
 * Chips
 * ------------------------------------------------------------------ */

export function ChangeChip({
  tone,
  children,
  title,
}: {
  tone: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={'sd-chip sd-chip-' + tone} title={title}>
      {children}
    </span>
  );
}

export function ChangeStatusChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  if (!code) return <span className="muted">&ndash;</span>;
  const tone = CHANGE_STATUS_TONE[code] ?? 'unknown';
  return (
    <ChangeChip tone={tone} title={'Change status: ' + label(code)}>
      <span className="sd-chip-mark" aria-hidden>
        {'\u25CF'}
      </span>
      {label(code)}
    </ChangeChip>
  );
}

export function ChangeTypeChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  if (!code) return <span className="muted">&ndash;</span>;
  const tone = CHANGE_TYPE_TONE[code] ?? 'unknown';
  return (
    <ChangeChip tone={tone} title={'Change type: ' + label(code)}>
      <span className="sd-chip-mark" aria-hidden>
        {code === 'EMERGENCY' ? '!' : '\u25CB'}
      </span>
      {label(code)}
    </ChangeChip>
  );
}

export function ChangeRiskChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  if (!code) {
    return (
      <ChangeChip tone="unknown" title="Risk has not been assessed">
        Not assessed
      </ChangeChip>
    );
  }
  const tone = CHANGE_RISK_TONE[code] ?? 'unknown';
  return (
    <ChangeChip tone={tone} title={'Risk level: ' + label(code)}>
      <span className="sd-chip-mark" aria-hidden>
        {'\u25B2'}
      </span>
      {label(code)} risk
    </ChangeChip>
  );
}

export function ApprovalStatusChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  if (!code) return <span className="muted">&ndash;</span>;
  const tone = APPROVAL_STATUS_TONE[code] ?? 'unknown';
  return (
    <ChangeChip tone={tone} title={'Approval: ' + label(code)}>
      {label(code)}
    </ChangeChip>
  );
}

export function ChangeRef({ row }: { row: Rec }) {
  const n = s(row.change_number) || 'CHG-' + s(row.id);
  const emergency = row.is_emergency === true || row.is_emergency === 'true';
  return (
    <div className="sd-ref-cell">
      <b className="td-cell-mono">{n}</b>
      <span className="sub muted">
        {emergency ? 'Emergency' : label(row.change_type)} &middot; {label(row.priority)}
      </span>
    </div>
  );
}

export function ChangeFact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="sd-fact">
      <span className="sd-fact-k">{k}</span>
      <span className="sd-fact-v">{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Change register
 * ------------------------------------------------------------------ */

const CHANGE_COLUMNS: Array<{ key: string; label: string; width?: string; render: (r: Rec) => ReactNode }> = [
  { key: 'ref', label: 'Change', width: '170px', render: (r) => <ChangeRef row={r} /> },
  {
    key: 'title',
    label: 'Title',
    render: (r) => (
      <div className="sd-subj-cell">
        <span className="sd-subj">{dash(r.title)}</span>
        <span className="sub muted">
          {dash(r.category_name)}
          {s(r.subcategory_name) ? ' / ' + s(r.subcategory_name) : ''}
        </span>
      </div>
    ),
  },
  { key: 'type', label: 'Type', width: '130px', render: (r) => <ChangeTypeChip value={r.change_type} /> },
  { key: 'risk', label: 'Risk', width: '130px', render: (r) => <ChangeRiskChip value={r.risk_level} /> },
  { key: 'status', label: 'Status', width: '150px', render: (r) => <ChangeStatusChip value={r.status} /> },
  {
    key: 'approvals',
    label: 'Approvals',
    width: '120px',
    render: (r) => {
      const pending = num(r.pending_approvals);
      const rejected = num(r.rejected_approvals);
      if (rejected > 0) return <span className="sd-danger">{rejected + ' rejected'}</span>;
      if (pending > 0) return <span className="muted">{pending + ' pending'}</span>;
      return <span className="muted">None outstanding</span>;
    },
  },
  {
    key: 'planned',
    label: 'Planned window',
    width: '190px',
    render: (r) => (
      <div className="sd-subj-cell">
        <span>{r.planned_start_at ? fmtDT(r.planned_start_at) : 'Not scheduled'}</span>
        <span className="sub muted">
          {r.planned_end_at ? 'to ' + fmtDT(r.planned_end_at) : 'no end set'}
        </span>
      </div>
    ),
  },
  {
    key: 'assignee',
    label: 'Assigned',
    width: '150px',
    render: (r) => <span className="muted">{s(r.assigned_to_name) || 'Unassigned'}</span>,
  },
  { key: 'age', label: 'Raised', width: '100px', render: (r) => <span className="muted">{fmtAgo(r.created_at)}</span> },
];

function ChangeTable({
  rows,
  onOpen,
  empty,
}: {
  rows: Rec[];
  onOpen: (r: Rec) => void;
  empty?: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table sd-change-table">
        <thead>
          <tr>
            {CHANGE_COLUMNS.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={CHANGE_COLUMNS.length}>{empty ?? 'No change requests match the current filters.'}</EmptyRow>}
          {rows.map((r) => (
            <tr
              key={s(r.id)}
              className={'sd-row' + (r.is_emergency ? ' sd-row-emergency' : '')}
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(r);
                }
              }}
            >
              {CHANGE_COLUMNS.map((c) => (
                <td key={c.key}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChangesList({ canCreate, categories }: { canCreate: boolean; categories: Rec[] }) {
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState(s(q.get('status')));
  const [changeType, setChangeType] = useState(s(q.get('changeType')));
  const [riskLevel, setRiskLevel] = useState(s(q.get('riskLevel')));
  const [search, setSearch] = useState(s(q.get('search')));
  const [scopeMode, setScopeMode] = useState(s(q.get('scope')));
  const [sortBy, setSortBy] = useState(s(q.get('sortBy')) || 'newest');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = qs({
      page,
      pageSize,
      status: status || undefined,
      changeType: changeType || undefined,
      riskLevel: riskLevel || undefined,
      search: search || undefined,
      sortBy,
      mine: scopeMode === 'mine' ? 'true' : undefined,
      pendingMyApproval: scopeMode === 'approvals' ? 'true' : undefined,
      emergencyOnly: scopeMode === 'emergency' ? 'true' : undefined,
    });
    sdApi<Rec>('/api/service-desk/changes' + params)
      .then((r) => {
        setRows(Array.isArray(r?.items) ? (r.items as Rec[]) : []);
        setTotal(num(r?.total));
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, [page, pageSize, status, changeType, riskLevel, search, scopeMode, sortBy]);

  useEffect(() => {
    load();
  }, [load]);

  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <SecCard
      title="Change register"
      sub="Every controlled change, its risk, its approval chain and its implementation window."
      actions={
        canCreate ? (
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/service-desk/changes/new')}>
            + Raise change
          </button>
        ) : null
      }
    >
      <div className="toolbar sd-filter-bar">
        <div className="field">
          <label htmlFor="chg-search">Search</label>
          <input
            id="chg-search"
            placeholder="Number, title, justification"
            value={search}
            onChange={(e) => reset(() => setSearch(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="chg-status">Status</label>
          <select id="chg-status" value={status} onChange={(e) => reset(() => setStatus(e.target.value))}>
            <option value="">All statuses</option>
            {Object.keys(CHANGE_STATUS_TONE).map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="chg-type">Type</label>
          <select id="chg-type" value={changeType} onChange={(e) => reset(() => setChangeType(e.target.value))}>
            <option value="">All types</option>
            <option value="NORMAL">Normal</option>
            <option value="STANDARD">Standard</option>
            <option value="EMERGENCY">Emergency</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="chg-risk">Risk</label>
          <select id="chg-risk" value={riskLevel} onChange={(e) => reset(() => setRiskLevel(e.target.value))}>
            <option value="">All risk levels</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="chg-scope">Scope</label>
          <select id="chg-scope" value={scopeMode} onChange={(e) => reset(() => setScopeMode(e.target.value))}>
            <option value="">All changes I can see</option>
            <option value="mine">Raised by or assigned to me</option>
            <option value="approvals">Awaiting my approval</option>
            <option value="emergency">Emergency changes</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="chg-sort">Sort</label>
          <select id="chg-sort" value={sortBy} onChange={(e) => reset(() => setSortBy(e.target.value))}>
            {CHANGE_SORTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <ErrorBanner error={error} /> : null}
      {loading ? (
        <Spinner />
      ) : (
        <>
          <ChangeTable rows={rows} onOpen={(r) => navigate('/service-desk/changes/' + s(r.id))} />
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />
        </>
      )}
      {categories.length === 0 && canCreate ? (
        <p className="muted sub" style={{ margin: '8px 0 0' }}>
          No service categories are available yet; a category is required before a change can be classified.
        </p>
      ) : null}
    </SecCard>
  );
}
/* ------------------------------------------------------------------ *
 * Stage strip
 * ------------------------------------------------------------------ */

/**
 * The pipeline the change is walking. Completed stages are filled, the current
 * stage is marked and labelled, and the strip is readable without colour.
 */
function WfStrip({ status, changeType }: { status: string; changeType: string }) {
  const emergency = s(changeType).toUpperCase() === 'EMERGENCY';
  const flow = emergency ? ['DRAFT', 'IMPLEMENTATION', 'VALIDATION', 'CLOSED'] : CHANGE_FLOW;
  const current = s(status).toUpperCase();
  const here = flow.indexOf(current);
  return (
    <div className="sd-wf" role="list" aria-label="Change pipeline">
      {flow.map((step, i) => {
        const done = here >= 0 && i < here;
        const on = i === here;
        return (
          <span key={step} className="sd-wf-cell">
            {i > 0 && (
              <span className="sd-wf-arrow" aria-hidden>
                {'\u2192'}
              </span>
            )}
            <span
              role="listitem"
              className={'sd-wf-step' + (on ? ' on' : '') + (done ? ' done' : '')}
              aria-current={on ? 'step' : undefined}
            >
              <span className="sd-wf-num" aria-hidden>
                {done ? '\u2713' : String(i + 1)}
              </span>
              {label(step)}
            </span>
          </span>
        );
      })}
      {here < 0 && (
        <span className="sd-wf-off">
          {label(current)}
          {current === 'REJECTED' ? ' - rework, then resubmit' : ''}
          {current === 'FAILED' ? ' - retry or roll back' : ''}
          {current === 'ROLLED_BACK' ? ' - back-out completed' : ''}
          {current === 'CANCELLED' ? ' - no further action' : ''}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Approval chain
 * ------------------------------------------------------------------ */

function ApprovalList({ items, canDecide, onDecide }: { items: Rec[]; canDecide: boolean; onDecide: (a: Rec, approve: boolean) => void }) {
  if (items.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>No approval steps have been generated yet. Submitting the change builds the chain.</p>;
  }
  return (
    <ul className="sd-approvals">
      {items.map((a) => (
        <li key={s(a.id)} className={'sd-approval' + (s(a.status) === 'PENDING' ? ' is-pending' : '')}>
          <div className="sd-approval-top">
            <span className="sd-approval-seq" aria-hidden>
              {s(a.seq)}
            </span>
            <div className="sd-approval-head">
              <b>{APPROVAL_TYPE_LABEL[s(a.approval_type).toUpperCase()] ?? label(a.approval_type)}</b>
              <span className="sub muted">
                {s(a.approver_name) ? 'Approver: ' + s(a.approver_name) : 'Approver role: ' + label(a.approver_role)}
              </span>
            </div>
            <ApprovalStatusChip value={a.status} />
          </div>
          {s(a.comments) && <p className="sd-approval-note">{s(a.comments)}</p>}
          <span className="sub muted">
            {s(a.decided_at) ? 'Decided ' + fmtDT(a.decided_at) : 'Awaiting a decision'}
          </span>
          {canDecide && s(a.status) === 'PENDING' && (
            <div className="sd-card-actions">
              <button className="btn btn-sm btn-primary" onClick={() => onDecide(a, true)}>
                Approve
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => onDecide(a, false)}>
                Reject
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Change record
 * ------------------------------------------------------------------ */

export function ChangeDetail({ id }: { id: number }) {
  const [data, setData] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [deciding, setDeciding] = useState<{ approvalId: number; approve: boolean } | null>(null);

  const load = useCallback(() => {
    setErr(null);
    sdApi<Rec>('/api/service-desk/changes/' + String(id))
      .then((r) => setData(r ?? null))
      .catch((e) => setErr(e));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const change: Rec = (data?.change as Rec) ?? {};
  const approvals: Rec[] = Array.isArray(data?.approvals) ? (data?.approvals as Rec[]) : [];
  const history: Rec[] = Array.isArray(data?.history) ? (data?.history as Rec[]) : [];
  const perms: Rec = (data?.permissions as Rec) ?? {};

  const run = async (path: string, body: Rec) => {
    setBusy(true);
    setErr(null);
    try {
      await sdPost('/api/service-desk/changes/' + String(id) + '/' + path, body);
      setDlg(null);
      setDeciding(null);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: number, approve: boolean, body: Rec) => {
    setBusy(true);
    setErr(null);
    try {
      await sdPost('/api/service-desk/changes/' + String(id) + '/approvals/decide', {
        approvalId,
        decision: approve ? 'APPROVED' : 'REJECTED',
        reject: !approve,
        ...body,
      });
      setDeciding(null);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="page sd-page" style={modStyle()}>
        {err ? <ErrorBanner error={err} /> : <Spinner />}
      </div>
    );
  }

  const canApprove = perms.approve === true && s(change.status) === 'PENDING_APPROVAL';

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title={s(change.change_number) || 'Change request'}
        kicker={'Service desk - change ' + dash(change.priority)}
        sub={dash(change.title)}
        actions={
          <div className="head-actions">
            <button className="btn btn-sm" onClick={() => navigate('/service-desk/changes')}>
              Back to register
            </button>
            {perms.update === true && (
              <button className="btn btn-sm" onClick={() => setDlg({ kind: 'edit' })}>
                Edit
              </button>
            )}
            {perms.submit === true && (
              <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'submit' })}>
                Submit for approval
              </button>
            )}
          </div>
        }
      />
      <SdTabs active="changes" />

      {err ? <ErrorBanner error={err} /> : null}

      <div className="sd-chips" style={{ marginBottom: 12 }}>
        <ChangeStatusChip value={change.status} />
        <ChangeTypeChip value={change.change_type} />
        <ChangeRiskChip value={change.risk_level} />
        <PriorityChip value={change.priority} />
        {(change.is_emergency === true || change.is_emergency === 'true') && (
          <ChangeChip tone="critical" title="Implemented before ratification">
            Emergency path
          </ChangeChip>
        )}
      </div>

      <div className="card card-pad sd-wf-card">
        <WfStrip status={s(change.status)} changeType={s(change.change_type)} />
      </div>

      <div className="sd-two-col">
        <div className="sd-stack">
          <SecCard title="Request" sub="What is changing and why" pad>
            <div className="sd-facts">
              <ChangeFact k="Requested by" v={dash(change.requested_by_name) || dash(change.created_by_name)} />
              <ChangeFact k="Category" v={dash(change.category_name)} />
              <ChangeFact k="Subcategory" v={dash(change.subcategory_name)} />
              <ChangeFact k="Assigned to" v={s(change.assigned_to_name) || s(change.assigned_team_name) || 'Unassigned'} />
              <ChangeFact
                k="Planned window"
                v={
                  change.planned_start_at
                    ? fmtDT(change.planned_start_at) + (change.planned_end_at ? ' to ' + fmtDT(change.planned_end_at) : '')
                    : 'Not scheduled'
                }
              />
              <ChangeFact
                k="Actual window"
                v={
                  change.actual_start_at
                    ? fmtDT(change.actual_start_at) + (change.actual_end_at ? ' to ' + fmtDT(change.actual_end_at) : ' (running)')
                    : 'Not started'
                }
              />
              <ChangeFact k="Downtime" v={num(change.downtime_minutes) > 0 ? String(num(change.downtime_minutes)) + ' minutes' : 'None recorded'} />
              <ChangeFact k="Affected systems" v={Array.isArray(change.affected_systems) && (change.affected_systems as unknown[]).length ? (change.affected_systems as unknown[]).map((x) => s(x)).join(', ') : 'None listed'} />
              <ChangeFact k="Related ticket" v={dash(change.related_ticket_number) || 'None'} />
              <ChangeFact k="Related problem" v={dash(change.related_problem_number) || 'None'} />
              <ChangeFact k="Raised" v={fmtDT(change.created_at)} />
            </div>
            {s(change.description) && (
              <>
                <h4 className="sd-sub-head">Description</h4>
                <pre className="sd-pre">{s(change.description)}</pre>
              </>
            )}
            {s(change.justification) && (
              <>
                <h4 className="sd-sub-head">Business justification</h4>
                <pre className="sd-pre">{s(change.justification)}</pre>
              </>
            )}
          </SecCard>

          <SecCard title="Risk and impact" sub="Assessed before implementation is authorised" pad>
            {s(change.risk_assessment) ? (
              <>
                <h4 className="sd-sub-head">Risk assessment</h4>
                <pre className="sd-pre">{s(change.risk_assessment)}</pre>
              </>
            ) : (
              <p className="muted" style={{ marginTop: 0 }}>No risk assessment has been recorded.</p>
            )}
            {s(change.impact_analysis) ? (
              <>
                <h4 className="sd-sub-head">Impact analysis</h4>
                <pre className="sd-pre">{s(change.impact_analysis)}</pre>
              </>
            ) : (
              <p className="muted">No impact analysis has been recorded.</p>
            )}
            {perms.update === true && (
              <div className="sd-card-actions">
                <button className="btn btn-sm" onClick={() => setDlg({ kind: 'risk' })}>
                  Record risk assessment
                </button>
                <button className="btn btn-sm" onClick={() => setDlg({ kind: 'impact' })}>
                  Record impact analysis
                </button>
              </div>
            )}
          </SecCard>

          <SecCard title="Plans" sub="Implementation, back-out and test" pad>
            {s(change.implementation_plan) ? (
              <>
                <h4 className="sd-sub-head">Implementation plan</h4>
                <pre className="sd-pre">{s(change.implementation_plan)}</pre>
              </>
            ) : (
              <p className="muted" style={{ marginTop: 0 }}>No implementation plan recorded.</p>
            )}
            {s(change.backout_plan) ? (
              <>
                <h4 className="sd-sub-head">Back-out plan</h4>
                <pre className="sd-pre">{s(change.backout_plan)}</pre>
              </>
            ) : (
              <p className="muted">No back-out plan recorded. A back-out plan is mandatory before implementation starts.</p>
            )}
            {s(change.test_plan) && (
              <>
                <h4 className="sd-sub-head">Test plan</h4>
                <pre className="sd-pre">{s(change.test_plan)}</pre>
              </>
            )}
            {s(change.validation_notes) && (
              <>
                <h4 className="sd-sub-head">Validation notes</h4>
                <pre className="sd-pre">{s(change.validation_notes)}</pre>
              </>
            )}
          </SecCard>

          <SecCard title="Action history" sub="Audited transitions on this change">
            {history.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No transitions recorded yet.</p>
            ) : (
              <ActivityFeed
                items={history.map((h) => ({
                  id: s(h.id),
                  kind: label(h.action),
                  at: s(h.created_at),
                  actorName: s(h.actor_name),
                  body: null,
                  meta: h,
                }))}
              />
            )}
          </SecCard>
        </div>

        <div className="sd-stack">
          <SecCard
            title="Approval chain"
            sub="CAB, risk and implementation authorisations"
            actions={
              canApprove ? (
                <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'approve' })}>
                  Record my approval
                </button>
              ) : null
            }
          >
            <ApprovalList
              items={approvals}
              canDecide={canApprove}
              onDecide={(a, approve) => setDeciding({ approvalId: num(a.id), approve })}
            />
          </SecCard>

          <SecCard title="Available actions" sub="Gated by stage and by your permissions">
            <div className="sd-act-row">
              {perms.implement === true && (
                <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'implement' })}>
                  Start implementation
                </button>
              )}
              {perms.implement === true && s(change.status) === 'IMPLEMENTATION' && (
                <button className="btn btn-sm" onClick={() => setDlg({ kind: 'complete' })}>
                  Complete implementation
                </button>
              )}
              {perms.validate === true && (
                <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'validate' })}>
                  Validate change
                </button>
              )}
              {perms.validate === true && (
                <button className="btn btn-sm btn-danger" onClick={() => setDlg({ kind: 'fail' })}>
                  Fail validation
                </button>
              )}
              {perms.rollback === true && (
                <button className="btn btn-sm sd-danger" onClick={() => setDlg({ kind: 'rollback' })}>
                  Roll back
                </button>
              )}
              {perms.close === true && (
                <button className="btn btn-sm" onClick={() => setDlg({ kind: 'close' })}>
                  Close change
                </button>
              )}
              {perms.retrospective === true && (
                <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'retro' })}>
                  Record retrospective approval
                </button>
              )}
              {perms.cancel === true && (
                <button className="btn btn-sm sd-danger" onClick={() => setDlg({ kind: 'cancel' })}>
                  Cancel change
                </button>
              )}
              {perms.submit !== true &&
                perms.implement !== true &&
                perms.validate !== true &&
                perms.close !== true &&
                perms.cancel !== true && <p className="muted" style={{ margin: 0 }}>No actions are available to you at this stage.</p>}
            </div>
          </SecCard>
        </div>
      </div>

      <ChangeDialogs
        dlg={dlg}
        change={change}
        approvals={approvals}
        busy={busy}
        error={err}
        onClose={() => setDlg(null)}
        act={run}
        patch={async (body) => {
          setBusy(true);
          setErr(null);
          try {
            await sdPatch('/api/service-desk/changes/' + String(id), body);
            setDlg(null);
            load();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
        decide={decide}
        deciding={deciding}
        onCloseDecide={() => setDeciding(null)}
      />
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Dialog scaffolding
 * ------------------------------------------------------------------ */

type Dlg =
  | null
  | { kind: 'edit' }
  | { kind: 'submit' }
  | { kind: 'risk' }
  | { kind: 'impact' }
  | { kind: 'implement' }
  | { kind: 'complete' }
  | { kind: 'validate' }
  | { kind: 'fail' }
  | { kind: 'rollback' }
  | { kind: 'close' }
  | { kind: 'retro' }
  | { kind: 'cancel' }
  | { kind: 'approve' };

type DlgProps = {
  change: Rec;
  approvals: Rec[];
  busy: boolean;
  error: unknown;
  onClose: () => void;
  act: (path: string, body: Rec) => void;
  patch: (body: Rec) => void;
  decide: (approvalId: number, approve: boolean, body: Rec) => void;
};

const CHANGE_TYPE_OPTS = [
  { value: 'NORMAL', label: 'Normal - assessed and CAB approved' },
  { value: 'STANDARD', label: 'Standard - pre-approved, low risk' },
  { value: 'EMERGENCY', label: 'Emergency - implement now, ratify afterwards' },
];

const CHANGE_PRIORITY_OPTS = [
  { value: 'P1', label: 'P1 - Critical' },
  { value: 'P2', label: 'P2 - High' },
  { value: 'P3', label: 'P3 - Medium' },
  { value: 'P4', label: 'P4 - Low' },
];

const CHANGE_RISK_OPTS = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
  { value: 'CRITICAL', label: 'Critical' },
];

function pad2(n: number): string {
  return n < 10 ? '0' + String(n) : String(n);
}

/** Local datetime string -> ISO, or undefined when the field is blank. */
function toIso(v: string): string | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** ISO instant -> the value shape an `input[type=datetime-local]` expects. */
function fromIso(v: unknown): string {
  const raw = s(v);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    'T' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

function commaText(v: unknown): string {
  return Array.isArray(v) ? v.map((x) => s(x)).filter(Boolean).join(', ') : s(v);
}

function splitList(v: string): string[] {
  return v
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Body builder that leaves optional text out rather than sending blanks. */
function body(): Rec {
  return {};
}

function put(b: Rec, key: string, value: unknown): Rec {
  if (value === undefined || value === null) return b;
  if (typeof value === 'string' && value.trim().length === 0) return b;
  b[key] = value;
  return b;
}

function ChgDlg({
  title,
  sub,
  busy,
  error,
  onClose,
  onSubmit,
  submitLabel,
  wide,
  danger,
  disabled,
  children,
}: {
  title: string;
  sub?: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  wide?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={wide}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? 'btn sd-danger' : 'btn btn-primary'}
            onClick={onSubmit}
            disabled={busy || disabled === true}
          >
            {busy ? 'Working...' : submitLabel}
          </button>
        </>
      }
    >
      {sub ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {sub}
        </p>
      ) : null}
      <div className="sd-form-grid">{children}</div>
      {error ? (
        <p className="sd-form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
/* ------------------------------------------------------------------ *
 * Individual dialogs
 * ------------------------------------------------------------------ */

function EditChangeDlg({ change, busy, error, onClose, patch }: DlgProps) {
  const [title, setTitle] = useState(s(change.title));
  const [description, setDescription] = useState(s(change.description));
  const [justification, setJustification] = useState(s(change.justification));
  const [priority, setPriority] = useState(s(change.priority));
  const [riskLevel, setRiskLevel] = useState(s(change.risk_level));
  const [plannedStart, setPlannedStart] = useState(fromIso(change.planned_start_at));
  const [plannedEnd, setPlannedEnd] = useState(fromIso(change.planned_end_at));
  const [systems, setSystems] = useState(commaText(change.affected_systems));
  const [implementationPlan, setImplementationPlan] = useState(s(change.implementation_plan));
  const [backoutPlan, setBackoutPlan] = useState(s(change.backout_plan));
  const [testPlan, setTestPlan] = useState(s(change.test_plan));

  const submit = () => {
    const b = body();
    put(b, 'title', title.trim());
    put(b, 'description', description);
    put(b, 'justification', justification);
    put(b, 'priority', priority);
    put(b, 'riskLevel', riskLevel);
    put(b, 'plannedStartAt', toIso(plannedStart));
    put(b, 'plannedEndAt', toIso(plannedEnd));
    put(b, 'affectedSystems', splitList(systems));
    put(b, 'implementationPlan', implementationPlan);
    put(b, 'backoutPlan', backoutPlan);
    put(b, 'testPlan', testPlan);
    patch(b);
  };

  return (
    <ChgDlg
      title="Edit change"
      sub="Corrections are audited. The change type is fixed once the record exists."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Save changes"
      wide
      disabled={title.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Title" req>
        <Inp value={title} onChange={setTitle} />
      </Field>
      <Field label="Priority">
        <Sel value={priority} onChange={setPriority} options={CHANGE_PRIORITY_OPTS} placeholder="Keep current" />
      </Field>
      <Field label="Risk level">
        <Sel value={riskLevel} onChange={setRiskLevel} options={CHANGE_RISK_OPTS} placeholder="Not assessed" />
      </Field>
      <Field label="Planned start">
        <Inp type="datetime-local" value={plannedStart} onChange={setPlannedStart} />
      </Field>
      <Field label="Planned end">
        <Inp type="datetime-local" value={plannedEnd} onChange={setPlannedEnd} />
      </Field>
      <Field label="Affected systems" hint="Comma separated free text">
        <Inp value={systems} onChange={setSystems} placeholder="ERP, Production network" />
      </Field>
      <Field label="Description">
        <Txa value={description} onChange={setDescription} rows={3} />
      </Field>
      <Field label="Business justification">
        <Txa value={justification} onChange={setJustification} rows={3} />
      </Field>
      <Field label="Implementation plan">
        <Txa value={implementationPlan} onChange={setImplementationPlan} rows={3} />
      </Field>
      <Field label="Back-out plan" hint="Mandatory before implementation begins">
        <Txa value={backoutPlan} onChange={setBackoutPlan} rows={3} />
      </Field>
      <Field label="Test plan">
        <Txa value={testPlan} onChange={setTestPlan} rows={3} />
      </Field>
    </ChgDlg>
  );
}

function SubmitDlg({ busy, error, onClose, act }: DlgProps) {
  const [note, setNote] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'note', note);
    act('submit', b);
  };
  return (
    <ChgDlg
      title="Submit for approval"
      sub="The approval chain is built from the category, risk level and change type. A standard change is pre-approved and moves straight on."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Submit change"
      onSubmit={submit}
    >
      <Field label="Note" hint="Added to the change history">
        <Txa value={note} onChange={setNote} rows={3} />
      </Field>
    </ChgDlg>
  );
}

function RiskDlg({ change, busy, error, onClose, act }: DlgProps) {
  const [riskLevel, setRiskLevel] = useState(s(change.risk_level) || 'MEDIUM');
  const [riskAssessment, setRiskAssessment] = useState(s(change.risk_assessment));
  const submit = () => {
    const b = body();
    put(b, 'riskLevel', riskLevel);
    put(b, 'riskAssessment', riskAssessment);
    act('risk', b);
  };
  return (
    <ChgDlg
      title="Record risk assessment"
      sub="Assess likelihood and consequence before the change reaches the advisory board."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Save assessment"
      wide
      onSubmit={submit}
    >
      <Field label="Risk level" req>
        <Sel value={riskLevel} onChange={setRiskLevel} options={CHANGE_RISK_OPTS} />
      </Field>
      <Field label="Assessment" hint="What could go wrong, how likely, how severe, and what mitigates it">
        <Txa value={riskAssessment} onChange={setRiskAssessment} rows={5} />
      </Field>
    </ChgDlg>
  );
}

function ImpactDlg({ change, busy, error, onClose, act }: DlgProps) {
  const [impactAnalysis, setImpactAnalysis] = useState(s(change.impact_analysis));
  const [systems, setSystems] = useState(commaText(change.affected_systems));
  const [downtime, setDowntime] = useState(s(change.downtime_minutes) === '0' ? '' : s(change.downtime_minutes));
  const submit = () => {
    const b = body();
    put(b, 'impactAnalysis', impactAnalysis);
    put(b, 'affectedSystems', splitList(systems));
    if (downtime.trim()) put(b, 'downtimeMinutes', num(downtime));
    act('impact', b);
  };
  return (
    <ChgDlg
      title="Record impact analysis"
      sub="Who and what is affected while the change runs, and for how long."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Save analysis"
      wide
      disabled={impactAnalysis.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Impact analysis" req>
        <Txa value={impactAnalysis} onChange={setImpactAnalysis} rows={5} />
      </Field>
      <Field label="Affected systems" hint="Comma separated">
        <Inp value={systems} onChange={setSystems} />
      </Field>
      <Field label="Expected downtime (minutes)">
        <Inp type="number" min={0} value={downtime} onChange={setDowntime} />
      </Field>
    </ChgDlg>
  );
}

function ImplementDlg({ change, busy, error, onClose, act }: DlgProps) {
  const [implementationPlan, setImplementationPlan] = useState(s(change.implementation_plan));
  const [backoutPlan, setBackoutPlan] = useState(s(change.backout_plan));
  const submit = () => {
    const b = body();
    put(b, 'implementationPlan', implementationPlan);
    put(b, 'backoutPlan', backoutPlan);
    act('implement', b);
  };
  return (
    <ChgDlg
      title="Start implementation"
      sub="A back-out plan is mandatory before a change enters implementation."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Start implementation"
      wide
      disabled={backoutPlan.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Implementation plan">
        <Txa value={implementationPlan} onChange={setImplementationPlan} rows={4} />
      </Field>
      <Field label="Back-out plan" req hint="Exactly how the change is reversed if it fails">
        <Txa value={backoutPlan} onChange={setBackoutPlan} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function CompleteDlg({ change, busy, error, onClose, act }: DlgProps) {
  const [downtime, setDowntime] = useState(s(change.downtime_minutes) === '0' ? '' : s(change.downtime_minutes));
  const [validationNotes, setValidationNotes] = useState(s(change.validation_notes));
  const submit = () => {
    const b = body();
    if (downtime.trim()) put(b, 'downtimeMinutes', num(downtime));
    put(b, 'validationNotes', validationNotes);
    act('complete', b);
  };
  return (
    <ChgDlg
      title="Complete implementation"
      sub="Hand the change to validation with the work that was actually carried out."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Complete implementation"
      wide
      onSubmit={submit}
    >
      <Field label="Actual downtime (minutes)">
        <Inp type="number" min={0} value={downtime} onChange={setDowntime} />
      </Field>
      <Field label="Technical notes">
        <Txa value={validationNotes} onChange={setValidationNotes} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function ValidateDlg({ busy, error, onClose, act }: DlgProps) {
  const [validationNotes, setValidationNotes] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'validationNotes', validationNotes);
    act('validate', b);
  };
  return (
    <ChgDlg
      title="Validate change"
      sub="Confirm the intended outcome was achieved and no unexpected effect was introduced."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Validate and close out"
      wide
      disabled={validationNotes.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Validation notes" req hint="What was checked and what the result was">
        <Txa value={validationNotes} onChange={setValidationNotes} rows={5} />
      </Field>
    </ChgDlg>
  );
}

function FailDlg({ busy, error, onClose, act }: DlgProps) {
  const [reason, setReason] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'reason', reason);
    act('fail-validation', b);
  };
  return (
    <ChgDlg
      title="Fail validation"
      sub="The change did not achieve its objective. It can be retried or rolled back."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Record failure"
      danger
      wide
      disabled={reason.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Reason" req>
        <Txa value={reason} onChange={setReason} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function RollbackDlg({ busy, error, onClose, act }: DlgProps) {
  const [reason, setReason] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'reason', reason);
    act('rollback', b);
  };
  return (
    <ChgDlg
      title="Roll back change"
      sub="Executes the back-out plan. The change is recorded as rolled back, not closed."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Roll back"
      danger
      wide
      disabled={reason.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Reason" req>
        <Txa value={reason} onChange={setReason} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function CloseDlg({ change, busy, error, onClose, act }: DlgProps) {
  const [note, setNote] = useState('');
  const emergency = change.is_emergency === true || change.is_emergency === 'true';
  const unratified = emergency && !s(change.retrospective_approval_at);
  const submit = () => {
    const b = body();
    put(b, 'note', note);
    act('close', b);
  };
  return (
    <ChgDlg
      title="Close change"
      sub={
        unratified
          ? 'This emergency change still needs its retrospective approval. Closure will be refused until that is recorded.'
          : 'Closes the change record. Nothing further can be changed afterwards.'
      }
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Close change"
      onSubmit={submit}
    >
      <Field label="Closure note">
        <Txa value={note} onChange={setNote} rows={3} />
      </Field>
    </ChgDlg>
  );
}

function RetroDlg({ busy, error, onClose, act }: DlgProps) {
  const [justification, setJustification] = useState('');
  const [decision, setDecision] = useState('approve');
  const submit = () => {
    const b = body();
    put(b, 'justification', justification);
    b.approved = decision === 'approve';
    act('retrospective-approval', b);
  };
  return (
    <ChgDlg
      title="Retrospective approval"
      sub="An emergency change implemented ahead of authorisation is ratified here. The person who implemented it cannot ratify their own change."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Record decision"
      wide
      disabled={justification.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Decision" req>
        <Sel
          value={decision}
          onChange={setDecision}
          options={[
            { value: 'approve', label: 'Ratify - the emergency action is accepted' },
            { value: 'withhold', label: 'Withhold - the action is not accepted' },
          ]}
        />
      </Field>
      <Field label="Justification" req>
        <Txa value={justification} onChange={setJustification} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function CancelDlg({ busy, error, onClose, act }: DlgProps) {
  const [reason, setReason] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'reason', reason);
    act('cancel', b);
  };
  return (
    <ChgDlg
      title="Cancel change"
      sub="The change will not proceed. The record is retained for audit."
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Cancel change"
      danger
      wide
      disabled={reason.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Reason" req>
        <Txa value={reason} onChange={setReason} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function ApproveDlg({ change, approvals, busy, error, onClose, act, decide }: DlgProps) {
  const [comments, setComments] = useState('');
  const first = approvals.find((a) => s(a.status) === 'PENDING');
  const submit = () => {
    const b = body();
    put(b, 'comments', comments);
    if (first) decide(num(first.id), true, b);
    else act('approve', b);
  };
  return (
    <ChgDlg
      title="Record my approval"
      sub={
        first
          ? 'Your decision is recorded against step ' + s(first.seq) + ' of the approval chain.'
          : 'No approval step is waiting on you. The change will be approved directly if your role permits it.'
      }
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel="Approve"
      wide
      onSubmit={submit}
    >
      <div className="sd-chips">
        <ChangeStatusChip value={change.status} />
        <ChangeRiskChip value={change.risk_level} />
      </div>
      <Field label="Comments">
        <Txa value={comments} onChange={setComments} rows={4} />
      </Field>
    </ChgDlg>
  );
}

function DecideDlg({
  approvalId,
  approve,
  busy,
  error,
  onClose,
  decide,
}: {
  approvalId: number;
  approve: boolean;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  decide: (approvalId: number, approve: boolean, body: Rec) => void;
}) {
  const [comments, setComments] = useState('');
  const submit = () => {
    const b = body();
    put(b, 'comments', comments);
    if (!approve) b.reject = true;
    decide(approvalId, approve, b);
  };
  return (
    <ChgDlg
      title={approve ? 'Approve change' : 'Reject change'}
      sub={
        approve
          ? 'Approving advances the change once every step in the chain has been decided.'
          : 'Rejecting returns the change for rework. A reason helps the raiser correct it.'
      }
      busy={busy}
      error={sdErr(error)}
      onClose={onClose}
      submitLabel={approve ? 'Approve' : 'Reject'}
      danger={!approve}
      wide
      disabled={!approve && comments.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Comments" req={!approve}>
        <Txa value={comments} onChange={setComments} rows={4} />
      </Field>
    </ChgDlg>
  );
}
/* ------------------------------------------------------------------ *
 * Dialog dispatch
 * ------------------------------------------------------------------ */

export function ChangeDialogs({
  dlg,
  change,
  approvals,
  busy,
  error,
  onClose,
  act,
  patch,
  decide,
  deciding,
  onCloseDecide,
}: {
  dlg: Dlg;
  change: Rec;
  approvals: Rec[];
  busy: boolean;
  error: unknown;
  onClose: () => void;
  act: (path: string, body: Rec) => void;
  patch: (body: Rec) => void;
  decide: (approvalId: number, approve: boolean, body: Rec) => void;
  deciding: { approvalId: number; approve: boolean } | null;
  onCloseDecide: () => void;
}) {
  const p: DlgProps = { change, approvals, busy, error, onClose, act, patch, decide };

  if (deciding) {
    return (
      <DecideDlg
        approvalId={deciding.approvalId}
        approve={deciding.approve}
        busy={busy}
        error={error}
        onClose={onCloseDecide}
        decide={decide}
      />
    );
  }

  if (!dlg) return null;

  switch (dlg.kind) {
    case 'edit':
      return <EditChangeDlg {...p} />;
    case 'submit':
      return <SubmitDlg {...p} />;
    case 'risk':
      return <RiskDlg {...p} />;
    case 'impact':
      return <ImpactDlg {...p} />;
    case 'implement':
      return <ImplementDlg {...p} />;
    case 'complete':
      return <CompleteDlg {...p} />;
    case 'validate':
      return <ValidateDlg {...p} />;
    case 'fail':
      return <FailDlg {...p} />;
    case 'rollback':
      return <RollbackDlg {...p} />;
    case 'close':
      return <CloseDlg {...p} />;
    case 'retro':
      return <RetroDlg {...p} />;
    case 'cancel':
      return <CancelDlg {...p} />;
    case 'approve':
      return <ApproveDlg {...p} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Raise a change
 * ------------------------------------------------------------------ */

function NewChangeDlg({
  categories,
  onClose,
  onCreated,
}: {
  categories: Rec[];
  onClose: () => void;
  onCreated: (id: number, submitted: boolean) => void;
}) {
  const [title, setTitle] = useState('');
  const [changeType, setChangeType] = useState('NORMAL');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [priority, setPriority] = useState('P3');
  const [riskLevel, setRiskLevel] = useState('');
  const [description, setDescription] = useState('');
  const [justification, setJustification] = useState('');
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedEnd, setPlannedEnd] = useState('');
  const [systems, setSystems] = useState('');
  const [implementationPlan, setImplementationPlan] = useState('');
  const [backoutPlan, setBackoutPlan] = useState('');
  const [submitNow, setSubmitNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = categories.find((c) => s(c.id) === categoryId);
  const subs: Rec[] = chosen && Array.isArray(chosen.subcategories) ? (chosen.subcategories as Rec[]) : [];
  const subOptions = subs.map((x) => ({ value: s(x.id), label: s(x.name) }));
  const categoryOptions = categories.map((c) => ({ value: s(c.id), label: s(c.name) }));

  const submit = () => {
    setBusy(true);
    setError('');
    const b = body();
    put(b, 'title', title.trim());
    put(b, 'changeType', changeType);
    if (categoryId) put(b, 'categoryId', num(categoryId));
    if (subcategoryId) put(b, 'subcategoryId', num(subcategoryId));
    put(b, 'priority', priority);
    put(b, 'riskLevel', riskLevel);
    put(b, 'description', description);
    put(b, 'justification', justification);
    put(b, 'plannedStartAt', toIso(plannedStart));
    put(b, 'plannedEndAt', toIso(plannedEnd));
    put(b, 'affectedSystems', splitList(systems));
    put(b, 'implementationPlan', implementationPlan);
    put(b, 'backoutPlan', backoutPlan);
    b.submit = submitNow;

    sdPost<Rec>('/api/service-desk/changes', b)
      .then((r) => {
        const change: Rec = (r?.change as Rec) ?? {};
        onCreated(num(change.id), submitNow);
      })
      .catch((e) => setError(sdErr(e)))
      .finally(() => setBusy(false));
  };

  return (
    <ChgDlg
      title="Raise a change request"
      sub="A normal change is assessed and approved. A standard change is pre-approved. An emergency change may be implemented ahead of authorisation and ratified afterwards."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel={submitNow ? 'Raise and submit' : 'Save as draft'}
      wide
      disabled={title.trim().length === 0}
      onSubmit={submit}
    >
      <Field label="Title" req>
        <Inp value={title} onChange={setTitle} placeholder="Upgrade production ERP application server" />
      </Field>
      <Field label="Change type" req>
        <Sel value={changeType} onChange={setChangeType} options={CHANGE_TYPE_OPTS} />
      </Field>
      <Field label="Category">
        <Sel
          value={categoryId}
          onChange={(v) => {
            setCategoryId(v);
            setSubcategoryId('');
          }}
          options={categoryOptions}
          placeholder="Uncategorised"
        />
      </Field>
      <Field label="Subcategory">
        <Sel value={subcategoryId} onChange={setSubcategoryId} options={subOptions} placeholder="None" />
      </Field>
      <Field label="Priority">
        <Sel value={priority} onChange={setPriority} options={CHANGE_PRIORITY_OPTS} />
      </Field>
      <Field label="Initial risk level">
        <Sel value={riskLevel} onChange={setRiskLevel} options={CHANGE_RISK_OPTS} placeholder="Assess later" />
      </Field>
      <Field label="Planned start">
        <Inp type="datetime-local" value={plannedStart} onChange={setPlannedStart} />
      </Field>
      <Field label="Planned end">
        <Inp type="datetime-local" value={plannedEnd} onChange={setPlannedEnd} />
      </Field>
      <Field label="Affected systems" hint="Comma separated">
        <Inp value={systems} onChange={setSystems} placeholder="ERP, Hikvision terminals" />
      </Field>
      <Field label="Description">
        <Txa value={description} onChange={setDescription} rows={3} />
      </Field>
      <Field label="Business justification">
        <Txa value={justification} onChange={setJustification} rows={3} />
      </Field>
      <Field label="Implementation plan">
        <Txa value={implementationPlan} onChange={setImplementationPlan} rows={3} />
      </Field>
      <Field label="Back-out plan" hint="Required before implementation can start">
        <Txa value={backoutPlan} onChange={setBackoutPlan} rows={3} />
      </Field>
      <label className="hk-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={submitNow} onChange={(e) => setSubmitNow(e.target.checked)} />
        <span className="hk-lbl" style={{ margin: 0 }}>
          Submit for approval immediately
        </span>
      </label>
    </ChgDlg>
  );
}

/* ------------------------------------------------------------------ *
 * Register surface
 * ------------------------------------------------------------------ */

function bucketName(r: Rec): string {
  return s(r.status ?? r.change_type ?? r.risk_level ?? r.key ?? r.label ?? r.name);
}

function bucketTotal(r: Rec): number {
  return num(r.total ?? r.count ?? r.value);
}

function bucketRows(v: unknown): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}

function Breakdown({ title, sub, rows }: { title: string; sub: string; rows: Rec[] }) {
  return (
    <SecCard title={title} sub={sub} pad>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing recorded yet.
        </p>
      ) : (
        <div className="sd-facts">
          {rows.map((r, i) => (
            <ChangeFact key={bucketName(r) + '-' + String(i)} k={label(bucketName(r))} v={bucketTotal(r)} />
          ))}
        </div>
      )}
    </SecCard>
  );
}

function WindowList({ rows, empty }: { rows: Rec[]; empty: string }) {
  if (rows.length === 0) return <Nothing text={empty} />;
  return (
    <ul className="sd-approvals">
      {rows.map((c) => (
        <li key={s(c.id)} className="sd-approval">
          <div className="sd-approval-top">
            <div className="sd-approval-head">
              <b>{s(c.title) || s(c.change_number)}</b>
              <span className="sub muted">
                {s(c.change_number)} &middot; {fmtDay(c.planned_start_at)}
              </span>
            </div>
            <ChangeStatusChip value={c.status} />
          </div>
          <div className="sd-card-actions">
            <button className="btn btn-sm" onClick={() => navigate('/service-desk/changes/' + s(c.id))}>
              Open change
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function ServiceDeskChanges({ id, create }: { id?: number | null; create?: boolean }) {
  const q = useHashQuery();
  const [dashboard, setDashboard] = useState<Rec | null>(null);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [creating, setCreating] = useState(false);

  const wantNew = create === true || s(q.get('new')) === '1';

  useEffect(() => {
    setCreating(wantNew);
  }, [wantNew]);

  useEffect(() => {
    if (id) return undefined;
    let live = true;
    sdApi<Rec>('/api/service-desk/changes/dashboard')
      .then((r) => {
        if (live) setDashboard(r ?? null);
      })
      .catch(() => undefined);
    sdApi<Rec[]>('/api/service-desk/categories')
      .then((r) => {
        if (live) setCategories(Array.isArray(r) ? r : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);

  if (id) return <ChangeDetail id={id} />;

  const scope: Rec = (dashboard?.scope as Rec) ?? {};
  const canCreate = !!scope.canCreate;
  const unratified = num(dashboard?.unratifiedEmergencyChanges);

  const closeNew = () => {
    setCreating(false);
    if (wantNew) navigate('/service-desk/changes');
  };

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title="Change management"
        kicker="Service desk - ITSM"
        sub="Controlled change from risk assessment and impact analysis through approval, implementation and validation to closure."
        actions={
          canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + Raise change
            </button>
          ) : null
        }
      />
      <SdTabs active="changes" />

      {dashboard ? (
        <KpiRow>
          <KpiTile
            label="Active changes"
            value={num(dashboard.activeChanges)}
            sub={num(dashboard.implementedChanges) + ' implemented'}
            onClick={() => navigate('/service-desk/changes')}
          />
          <KpiTile
            label="Awaiting approval"
            value={num(dashboard.awaitingApproval)}
            sub={num(dashboard.myApprovals) + ' need my decision'}
            onClick={() => navigate('/service-desk/changes?scope=approvals')}
          />
          <KpiTile
            label="Emergency unratified"
            value={unratified}
            sub={unratified > 0 ? 'Retrospective approval outstanding' : 'All emergency changes ratified'}
            accent={unratified > 0 ? '#FF0000' : undefined}
            tint={unratified > 0 ? 'rgba(255, 0, 0, 0.10)' : undefined}
            onClick={() => navigate('/service-desk/changes?scope=emergency')}
          />
          <KpiTile
            label="Success rate"
            value={num(dashboard.successRate) + '%'}
            sub={num(dashboard.failedChanges) + ' failed, ' + num(dashboard.rolledBackChanges) + ' rolled back'}
          />
        </KpiRow>
      ) : null}

      <ChangesList canCreate={canCreate} categories={categories} />

      {dashboard ? (
        <div className="sd-two-col">
          <SecCard title="Upcoming change windows" sub="Scheduled work the organisation should expect" pad>
            <WindowList rows={bucketRows(dashboard.upcomingChanges)} empty="No change window is scheduled." />
          </SecCard>
          <div className="sd-stack">
            <SecCard title="Overdue changes" sub="Planned end has passed without closure" pad>
              <WindowList rows={bucketRows(dashboard.overdueChanges)} empty="No change is overdue." />
            </SecCard>
            <Breakdown title="By risk" sub="Where the risk sits across the register" rows={bucketRows(dashboard.byRisk)} />
            <Breakdown title="By type" sub="Normal, standard and emergency" rows={bucketRows(dashboard.byType)} />
          </div>
        </div>
      ) : null}

      {creating ? (
        <NewChangeDlg
          categories={categories}
          onClose={closeNew}
          onCreated={(newId, submitted) => {
            setCreating(false);
            if (newId) navigate('/service-desk/changes/' + String(newId));
            else {
              navigate(submitted ? '/service-desk/changes?scope=mine' : '/service-desk/changes');
            }
          }}
        />
      ) : null}
    </div>
  );
}
