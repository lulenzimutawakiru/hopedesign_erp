import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, Modal, Pager, Spinner } from '../../components/ui';
import { Field, FormErr, Inp, Sel, Txa } from '../hikvision/fields';
import { qs } from '../hikvision/hkutil';
import {
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
 * Problem management (spec 18)
 *
 * Multiple incidents -> pattern detected -> problem created -> root cause
 * investigation -> known error -> permanent fix -> problem closed.
 * ------------------------------------------------------------------ */

const PROBLEM_STATUS_TONE: Record<string, string> = {
  NEW: 'new',
  INVESTIGATING: 'progress',
  ROOT_CAUSE_IDENTIFIED: 'rca',
  KNOWN_ERROR: 'known',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
};

const KNOWN_ERROR_TONE: Record<string, string> = {
  ACTIVE: 'active',
  FIX_PENDING: 'pending',
  RESOLVED: 'resolved',
  ARCHIVED: 'archived',
};

const RCA_TONE: Record<string, string> = {
  DRAFT: 'draft',
  IN_REVIEW: 'review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const LINK_TYPE_LABEL: Record<string, string> = {
  TRIGGERING: 'Triggering incident',
  MATCHED: 'Matched incident',
  MANUAL: 'Linked manually',
};

const RCA_METHODS = ['FIVE_WHYS', 'FISHBONE', 'FAULT_TREE', 'KEPNER_TREGOE', 'OTHER'];

export function ToneChip({ tone, children, title }: { tone: string; children: string; title?: string }) {
  return (
    <span className={'sd-chip sd-chip-' + tone} title={title}>
      {children}
    </span>
  );
}

export function ProblemStatusChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <ToneChip tone={PROBLEM_STATUS_TONE[code] ?? 'unknown'}>{code ? label(code) : 'Unknown'}</ToneChip>;
}

export function KnownErrorChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <ToneChip tone={KNOWN_ERROR_TONE[code] ?? 'unknown'}>{code ? label(code) : 'Unknown'}</ToneChip>;
}

export function RcaStatusChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <ToneChip tone={RCA_TONE[code] ?? 'unknown'}>{code ? label(code) : 'Unknown'}</ToneChip>;
}

export function ProblemRef({ row }: { row: Rec }) {
  return (
    <div className="sd-ref-cell">
      <b className="td-cell-mono">{dash(row.problem_number)}</b>
      <span className="sub muted">{label(row.status)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Problem list
 * ------------------------------------------------------------------ */

const PROBLEM_SORTS: Array<[string, string]> = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['priority', 'Priority'],
  ['incidents', 'Most incidents'],
  ['number', 'Problem number'],
];

function ProblemsList({ canCreate, categories }: { canCreate: boolean; categories: Rec[] }) {
  const q = useHashQuery();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(num(q.get('pageSize')) || 25);
  const [status, setStatus] = useState(s(q.get('status')));
  const [priority, setPriority] = useState(s(q.get('priority')));
  const [categoryId, setCategoryId] = useState(s(q.get('categoryId')));
  const [mine, setMine] = useState(s(q.get('mine')) === 'true');
  const [sortBy, setSortBy] = useState(s(q.get('sortBy')) || 'newest');
  const [search, setSearch] = useState(s(q.get('search')));
  const [term, setTerm] = useState(s(q.get('search')));

  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<{ items: Rec[]; total: number }>(
      '/api/service-desk/problems' +
        qs({ page, pageSize, status, priority, categoryId, mine: mine ? 'true' : '', sortBy, search })
    )
      .then((r) => {
        setRows(Array.isArray(r.items) ? r.items : []);
        setTotal(num(r.total));
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [page, pageSize, status, priority, categoryId, mine, sortBy, search]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setPage(1);
      setSearch(term.trim());
    }, 350);
    return () => window.clearTimeout(t);
  }, [term]);

  const categoryOptions = categories.map((c) => ({ value: s(c.id), label: s(c.name) }));

  return (
    <div className="sd-stack">
      <SecCard
        title="Problem register"
        sub="Recurring incidents grouped into a single problem record with root cause and permanent fix."
        pad
        actions={
          canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/service-desk/problems?new=1')}>
              + New problem
            </button>
          ) : null
        }
      >
        <div className="filter-bar sd-filter-bar">
          <Field label="Search">
            <Inp value={term} onChange={setTerm} placeholder="Number, title or description" />
          </Field>
          <Field label="Status">
            <Sel
              value={status}
              onChange={(v) => {
                setPage(1);
                setStatus(v);
              }}
              options={[
                ['NEW', 'New'],
                ['INVESTIGATING', 'Investigating'],
                ['ROOT_CAUSE_IDENTIFIED', 'Root cause identified'],
                ['KNOWN_ERROR', 'Known error'],
                ['RESOLVED', 'Resolved'],
                ['CLOSED', 'Closed'],
                ['CANCELLED', 'Cancelled'],
              ].map(([value, lab]) => ({ value, label: lab }))}
              placeholder="Any status"
            />
          </Field>
          <Field label="Priority">
            <Sel
              value={priority}
              onChange={(v) => {
                setPage(1);
                setPriority(v);
              }}
              options={['P1', 'P2', 'P3', 'P4'].map((p) => ({ value: p, label: p }))}
              placeholder="Any priority"
            />
          </Field>
          <Field label="Category">
            <Sel
              value={categoryId}
              onChange={(v) => {
                setPage(1);
                setCategoryId(v);
              }}
              options={categoryOptions}
              placeholder="Any category"
            />
          </Field>
          <Field label="Order">
            <Sel value={sortBy} onChange={setSortBy} options={PROBLEM_SORTS.map(([value, lab]) => ({ value, label: lab }))} />
          </Field>
          <Field label="Ownership">
            <button
              className={mine ? 'chip active' : 'chip'}
              onClick={() => {
                setPage(1);
                setMine((v) => !v);
              }}
            >
              Assigned to me
            </button>
          </Field>
        </div>
      </SecCard>

      <SecCard title="Problems" sub={total + ' record(s) in scope'}>
        {error ? <div className="card-pad"><ErrorBanner error={error} /></div> : null}
        {loading ? (
          <div className="card-pad">
            <Spinner />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table sd-problem-table">
              <thead>
                <tr>
                  <th style={{ width: 170 }}>Problem</th>
                  <th>Title</th>
                  <th style={{ width: 160 }}>Category</th>
                  <th style={{ width: 110 }}>Priority</th>
                  <th style={{ width: 120 }}>Incidents</th>
                  <th style={{ width: 110 }}>Known errors</th>
                  <th style={{ width: 160 }}>Assigned</th>
                  <th style={{ width: 120 }}>Raised</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <EmptyRow cols={8}>
                    <Nothing text="No problems match these filters." />
                  </EmptyRow>
                )}
                {rows.map((r) => (
                  <tr
                    key={s(r.id)}
                    className="sd-row"
                    onClick={() => navigate('/service-desk/problems/' + s(r.id))}
                  >
                    <td>
                      <ProblemRef row={r} />
                    </td>
                    <td>
                      <div className="sd-subj-cell">
                        <span className="sd-subj">{dash(r.title)}</span>
                        <span className="sub muted">{dash(r.subcategory_name)}</span>
                      </div>
                    </td>
                    <td className="muted">{dash(r.category_name)}</td>
                    <td>
                      <PriorityChip value={r.priority} compact />
                    </td>
                    <td>
                      <b>{num(r.incident_count)}</b>
                    </td>
                    <td>{num(r.known_error_count) ? num(r.known_error_count) : <span className="muted">0</span>}</td>
                    <td className="muted">{dash(r.assigned_to_name)}</td>
                    <td className="muted">{fmtAgo(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot">
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />
        </div>
      </SecCard>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pattern detection
 * ------------------------------------------------------------------ */

interface Candidate {
  categoryId: number | null;
  subcategoryId: number | null;
  categoryName: string | null;
  subcategoryName: string | null;
  incidentCount: number;
  ticketNumbers: string[];
  priorities: string[];
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  linkedIncidentCount: number;
  alreadyProblem: boolean;
  existingProblemId: number | null;
  existingProblemNumber: string | null;
  existingProblemStatus: string | null;
}

function CandidatesPanel({ canCreate }: { canCreate: boolean }) {
  const [days, setDays] = useState('30');
  const [minCount, setMinCount] = useState('3');
  const [data, setData] = useState<{ items: Candidate[]; total: number; suggested: number; windowDays: number; minCount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<{ items: Candidate[]; total: number; suggested: number; windowDays: number; minCount: number }>(
      '/api/service-desk/problems/candidates' + qs({ days, minCount })
    )
      .then((r) => setData(r ?? null))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [days, minCount]);

  useEffect(() => void load(), [load]);

  const items = data?.items ?? [];

  return (
    <div className="sd-stack">
      <SecCard
        title="Recurring incident detection"
        sub="Incidents clustered by category and subcategory inside the analysis window. Promote a cluster to a problem to start root cause investigation."
        pad
      >
        <div className="filter-bar sd-filter-bar">
          <Field label="Window" hint="Days of history to scan">
            <Sel
              value={days}
              onChange={setDays}
              options={[
                ['7', 'Last 7 days'],
                ['14', 'Last 14 days'],
                ['30', 'Last 30 days'],
                ['60', 'Last 60 days'],
                ['90', 'Last 90 days'],
              ].map(([value, lab]) => ({ value, label: lab }))}
            />
          </Field>
          <Field label="Minimum incidents" hint="A cluster must reach this count">
            <Sel
              value={minCount}
              onChange={setMinCount}
              options={['2', '3', '4', '5', '10'].map((c) => ({ value: c, label: c + ' or more' }))}
            />
          </Field>
          <Field label="Summary">
            <span className="muted">
              {num(data?.total)} cluster(s), {num(data?.suggested)} awaiting a problem record
            </span>
          </Field>
        </div>
      </SecCard>

      {error ? <ErrorBanner error={error} /> : null}
      {loading && !data ? (
        <SecCard title="Detected patterns">
          <div className="card-pad">
            <Spinner />
          </div>
        </SecCard>
      ) : (
        <SecCard title="Detected patterns" sub={(data?.windowDays ?? 0) + ' day window, minimum ' + (data?.minCount ?? 0)}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th style={{ width: 100 }}>Incidents</th>
                  <th style={{ width: 150 }}>Priorities</th>
                  <th style={{ width: 170 }}>First / last</th>
                  <th style={{ width: 220 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <EmptyRow cols={5}>
                    <Nothing text="No recurring cluster crossed the threshold. Nothing to investigate." />
                  </EmptyRow>
                )}
                {items.map((c, i) => (
                  <tr key={s(c.subcategoryId ?? c.categoryId) + '-' + i}>
                    <td>
                      <div className="sd-subj-cell">
                        <span className="sd-subj">{dash(c.categoryName)}</span>
                        <span className="sub muted">
                          {dash(c.subcategoryName)}
                          {c.ticketNumbers.length ? ' - ' + c.ticketNumbers.slice(0, 4).join(', ') : ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <b>{c.incidentCount}</b>
                      {c.linkedIncidentCount > 0 && (
                        <span className="sub muted">{c.linkedIncidentCount} already linked</span>
                      )}
                    </td>
                    <td>
                      <div className="sd-chip-row">
                        {c.priorities.slice(0, 4).map((p) => (
                          <PriorityChip key={p} value={p} compact />
                        ))}
                      </div>
                    </td>
                    <td className="muted">
                      {fmtDT(c.firstOpenedAt)}
                      <br />
                      {fmtAgo(c.lastOpenedAt)}
                    </td>
                    <td>
                      {c.alreadyProblem ? (
                        <div className="sd-row-act">
                          <ToneChip tone={PROBLEM_STATUS_TONE[s(c.existingProblemStatus).toUpperCase()] ?? 'unknown'}>
                            {dash(c.existingProblemNumber)}
                          </ToneChip>
                          <button
                            className="btn btn-sm"
                            onClick={() => navigate('/service-desk/problems/' + s(c.existingProblemId))}
                          >
                            Open
                          </button>
                        </div>
                      ) : canCreate ? (
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            navigate(
                              '/service-desk/problems' +
                                qs({
                                  new: '1',
                                  categoryId: s(c.categoryId),
                                  subcategoryId: s(c.subcategoryId),
                                  title: (c.categoryName ?? 'Recurring incident') + ' - ' + (c.subcategoryName ?? 'unspecified'),
                                  tickets: c.ticketNumbers.join(','),
                                })
                            )
                          }
                        >
                          Create problem
                        </button>
                      ) : (
                        <span className="muted">No permission</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SecCard>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Known errors register
 * ------------------------------------------------------------------ */

function KnownErrorsPanel() {
  const [status, setStatus] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Rec[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [detail, setDetail] = useState<Rec | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<{ items: Rec[]; total: number }>(
      '/api/service-desk/known-errors' +
        qs({ page, pageSize: 25, status, search, includeArchived: includeArchived ? 'true' : '' })
    )
      .then((r) => setData(r ?? { items: [], total: 0 }))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [page, status, search, includeArchived]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setPage(1);
      setSearch(term.trim());
    }, 350);
    return () => window.clearTimeout(t);
  }, [term]);

  const rows = data?.items ?? [];

  return (
    <div className="sd-stack">
      <SecCard
        title="Known errors"
        sub="Documented failures with a workaround. Agents attach these to incidents so the workaround is applied immediately."
        pad
      >
        <div className="filter-bar sd-filter-bar">
          <Field label="Search">
            <Inp value={term} onChange={setTerm} placeholder="Code, title or symptom" />
          </Field>
          <Field label="Status">
            <Sel
              value={status}
              onChange={(v) => {
                setPage(1);
                setStatus(v);
              }}
              options={['ACTIVE', 'FIX_PENDING', 'RESOLVED', 'ARCHIVED'].map((v) => ({ value: v, label: label(v) }))}
              placeholder="Any status"
            />
          </Field>
          <Field label="Archive">
            <button
              className={includeArchived ? 'chip active' : 'chip'}
              onClick={() => {
                setPage(1);
                setIncludeArchived((v) => !v);
              }}
            >
              Include archived
            </button>
          </Field>
        </div>
      </SecCard>

      {error ? <ErrorBanner error={error} /> : null}

      <SecCard title="Register" sub={num(data?.total) + ' record(s)'}>
        {loading ? (
          <div className="card-pad">
            <Spinner />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Code</th>
                  <th>Title</th>
                  <th style={{ width: 160 }}>Problem</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 110 }}>Agent visible</th>
                  <th style={{ width: 120 }}>Updated</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <EmptyRow cols={7}>
                    <Nothing text="No known errors recorded." />
                  </EmptyRow>
                )}
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{dash(r.error_code)}</td>
                    <td>
                      <div className="sd-subj-cell">
                        <span className="sd-subj">{dash(r.title)}</span>
                        <span className="sub muted">{dash(r.symptoms).slice(0, 120)}</span>
                      </div>
                    </td>
                    <td className="td-cell-mono">{dash(r.problem_number)}</td>
                    <td>
                      <KnownErrorChip value={r.status} />
                    </td>
                    <td className="muted">{r.agent_visible ? 'Yes' : 'No'}</td>
                    <td className="muted">{fmtAgo(r.updated_at)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => void openKnownError(r.id, setDetail, setError)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot">
          <Pager page={page} pageSize={25} total={num(data?.total)} onPage={setPage} />
        </div>
      </SecCard>

      {detail ? <KnownErrorModal row={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

async function openKnownError(id: unknown, set: (r: Rec) => void, setError: (e: unknown) => void) {
  try {
    const r = await sdApi<Rec>('/api/service-desk/known-errors/' + s(id));
    set(r);
  } catch (e) {
    setError(e);
  }
}

function KnownErrorModal({ row, onClose }: { row: Rec; onClose: () => void }) {
  return (
    <Modal
      title={'Known error ' + dash(row.error_code)}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="sd-facts">
        <Fact k="Title" v={dash(row.title)} />
        <Fact k="Problem" v={dash(row.problem_number)} />
        <Fact k="Status" v={<KnownErrorChip value={row.status} />} />
        <Fact k="Agent visible" v={row.agent_visible ? 'Yes' : 'No'} />
        <Fact k="Created" v={fmtDT(row.created_at)} />
        <Fact k="Updated" v={fmtDT(row.updated_at)} />
      </div>
      <h4 className="sd-sub-head">Symptoms</h4>
      <p className="sd-pre">{dash(row.symptoms)}</p>
      <h4 className="sd-sub-head">Workaround</h4>
      <p className="sd-pre">{dash(row.workaround)}</p>
    </Modal>
  );
}

export function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="sd-fact">
      <span className="sd-fact-k">{k}</span>
      <span className="sd-fact-v">{v}</span>
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Problem detail
 * ------------------------------------------------------------------ */

type Dlg =
  | { kind: 'investigate' }
  | { kind: 'rootCause' }
  | { kind: 'knownError' }
  | { kind: 'resolve' }
  | { kind: 'close' }
  | { kind: 'cancel' }
  | { kind: 'reopen' }
  | { kind: 'link' }
  | { kind: 'createKe' }
  | { kind: 'rca' }
  | { kind: 'rcaReview'; id: number }
  | { kind: 'edit' }
  | null;

const PANELS: Array<[string, string]> = [
  ['overview', 'Overview'],
  ['incidents', 'Linked incidents'],
  ['rca', 'Root cause'],
  ['known', 'Known errors'],
  ['history', 'History'],
];

export function ProblemDetail({ id }: { id: number }) {
  const q = useHashQuery();
  const [panel, setPanel] = useState(s(q.get('panel')) || 'overview');
  const [data, setData] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState('');
  const [rcaView, setRcaView] = useState<Rec | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<Rec>('/api/service-desk/problems/' + String(id))
      .then((r) => setData(r ?? null))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => void load(), [load, tick]);
  const refresh = () => setTick((t) => t + 1);

  const problem: Rec = (data?.problem as Rec) ?? {};
  const incidents: Rec[] = Array.isArray(data?.incidents) ? (data?.incidents as Rec[]) : [];
  const knownErrors: Rec[] = Array.isArray(data?.knownErrors) ? (data?.knownErrors as Rec[]) : [];
  const analyses: Rec[] = Array.isArray(data?.analyses) ? (data?.analyses as Rec[]) : [];
  const history: Rec[] = Array.isArray(data?.history) ? (data?.history as Rec[]) : [];
  const perms: Rec = (data?.permissions as Rec) ?? {};
  const status = s(problem.status).toUpperCase();

  const act = (path: string, payload: Rec) => {
    setBusy(true);
    setDlgError('');
    sdPost('/api/service-desk/problems/' + String(id) + path, payload)
      .then(() => {
        setDlg(null);
        refresh();
      })
      .catch((e) => setDlgError(sdErr(e)))
      .finally(() => setBusy(false));
  };

  if (loading && !data) {
    return (
      <>
        <SdHead title="Problem" kicker="Problem management" />
        <div className="center-box">
          <Spinner />
        </div>
      </>
    );
  }

  return (
    <>
      <SdHead
        title={dash(problem.title)}
        kicker="Problem management"
        sub={dash(problem.problem_number) + ' - ' + label(problem.status) + ' - opened ' + fmtDT(problem.identified_at ?? problem.created_at)}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => navigate('/service-desk/problems')}>
              Back to register
            </button>
            {perms.update ? (
              <button className="btn btn-sm" onClick={() => setDlg({ kind: 'edit' })}>
                Edit
              </button>
            ) : null}
            {perms.investigate && status !== 'CLOSED' && status !== 'CANCELLED' ? (
              <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'investigate' })}>
                Investigate
              </button>
            ) : null}
          </>
        }
      />
      <SdTabs active="problems" />
      <ErrorBanner error={error} />

      {error ? null : (
        <>
          <KpiRow>
            <KpiTile label="Status" value={label(problem.status)} sub={label(problem.priority)} />
            <KpiTile label="Linked incidents" value={num(problem.incident_count)} sub={incidents.length + ' showing'} />
            <KpiTile label="Known errors" value={knownErrors.length} sub={knownErrors.filter((k) => s(k.status) === 'ACTIVE').length + ' active'} />
            <KpiTile label="Analyses" value={analyses.length} sub={analyses.filter((a) => s(a.status) === 'APPROVED').length + ' approved'} />
            <KpiTile label="Root cause" value={s(problem.root_cause) ? 'Recorded' : 'Open'} sub={s(problem.permanent_fix) ? 'Permanent fix recorded' : 'No permanent fix yet'} />
          </KpiRow>

          <div className="tabs sd-sub-tabs">
            {PANELS.map(([key, text]) => (
              <button
                key={key}
                className={key === panel ? 'tab active' : 'tab'}
                onClick={() => {
                  setPanel(key);
                  navigate('/service-desk/problems/' + String(id), { query: { panel: key } });
                }}
              >
                {text}
                {key === 'incidents' && incidents.length > 0 ? ' (' + incidents.length + ')' : ''}
                {key === 'rca' && analyses.length > 0 ? ' (' + analyses.length + ')' : ''}
                {key === 'known' && knownErrors.length > 0 ? ' (' + knownErrors.length + ')' : ''}
              </button>
            ))}
          </div>

          {panel === 'overview' ? (
            <div className="sd-stack">
              <SecCard title="Description" pad>
                <p className="sd-pre">{dash(problem.description)}</p>
              </SecCard>
              <div className="sd-two-col">
                <SecCard title="Root cause" pad>
                  <p className="sd-pre">{s(problem.root_cause) ? s(problem.root_cause) : 'Not yet identified.'}</p>
                </SecCard>
                <SecCard title="Workaround" pad>
                  <p className="sd-pre">{s(problem.workaround) ? s(problem.workaround) : 'No workaround recorded.'}</p>
                </SecCard>
              </div>
              <SecCard title="Permanent fix" pad>
                <p className="sd-pre">{s(problem.permanent_fix) ? s(problem.permanent_fix) : 'Not yet implemented.'}</p>
              </SecCard>
              <SecCard title="Record" pad>
                <div className="sd-facts">
                  <Fact k="Problem number" v={dash(problem.problem_number)} />
                  <Fact k="Category" v={dash(problem.category_name)} />
                  <Fact k="Subcategory" v={dash(problem.subcategory_name)} />
                  <Fact k="Priority" v={<PriorityChip value={problem.priority} />} />
                  <Fact k="Impact" v={label(problem.impact)} />
                  <Fact k="Assigned to" v={dash(problem.assigned_to_name)} />
                  <Fact k="Team" v={dash(problem.assigned_team_name)} />
                  <Fact k="Raised by" v={dash(problem.created_by_name)} />
                  <Fact k="Identified" v={fmtDT(problem.identified_at)} />
                  <Fact k="Resolved" v={fmtDT(problem.resolved_at)} />
                  <Fact k="Closed" v={fmtDT(problem.closed_at)} />
                  <Fact k="Last updated" v={fmtDT(problem.updated_at)} />
                </div>
              </SecCard>
              <SecCard title="Problem workflow" sub="Problems are closed only when every linked incident is resolved." pad>
                <div className="sd-wf">
                  <span className={status === 'NEW' ? 'sd-wf-step on' : 'sd-wf-step'}>Raised</span>
                  <span className="sd-wf-arrow" aria-hidden>{'\u2192'}</span>
                  <span className={status === 'INVESTIGATING' ? 'sd-wf-step on' : 'sd-wf-step'}>Investigated</span>
                  <span className="sd-wf-arrow" aria-hidden>{'\u2192'}</span>
                  <span className={status === 'ROOT_CAUSE_IDENTIFIED' ? 'sd-wf-step on' : 'sd-wf-step'}>Root cause</span>
                  <span className="sd-wf-arrow" aria-hidden>{'\u2192'}</span>
                  <span className={status === 'KNOWN_ERROR' ? 'sd-wf-step on' : 'sd-wf-step'}>Known error</span>
                  <span className="sd-wf-arrow" aria-hidden>{'\u2192'}</span>
                  <span className={status === 'RESOLVED' ? 'sd-wf-step on' : 'sd-wf-step'}>Resolved</span>
                  <span className="sd-wf-arrow" aria-hidden>{'\u2192'}</span>
                  <span className={status === 'CLOSED' ? 'sd-wf-step on' : 'sd-wf-step'}>Closed</span>
                </div>
                <div className="sd-act-row" style={{ marginTop: 14 }}>
                  {perms.investigate && status !== 'CLOSED' && status !== 'CANCELLED' ? (
                    <button className="btn btn-sm" onClick={() => setDlg({ kind: 'rootCause' })}>
                      Record root cause
                    </button>
                  ) : null}
                  {perms.knownErrors ? (
                    <button className="btn btn-sm" onClick={() => setDlg({ kind: 'knownError' })}>
                      Mark as known error
                    </button>
                  ) : null}
                  {perms.resolve && status !== 'RESOLVED' && status !== 'CLOSED' ? (
                    <button className="btn btn-sm btn-primary" onClick={() => setDlg({ kind: 'resolve' })}>
                      Resolve with permanent fix
                    </button>
                  ) : null}
                  {perms.close && status !== 'CLOSED' ? (
                    <button className="btn btn-sm" onClick={() => setDlg({ kind: 'close' })}>
                      Close problem
                    </button>
                  ) : null}
                  {perms.update && status === 'CLOSED' ? (
                    <button className="btn btn-sm" onClick={() => setDlg({ kind: 'reopen' })}>
                      Reopen
                    </button>
                  ) : null}
                  {perms.update && status !== 'CLOSED' && status !== 'CANCELLED' ? (
                    <button className="btn btn-sm sd-danger" onClick={() => setDlg({ kind: 'cancel' })}>
                      Cancel
                    </button>
                  ) : null}
                </div>
              </SecCard>
            </div>
          ) : null}

          {panel === 'incidents' ? (
            <SecCard
              title="Linked incidents"
              sub="Every ticket that fed this problem. Closing the problem is blocked while these are still open."
              pad
              actions={
                perms.update ? (
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'link' })}>
                    Link incident
                  </button>
                ) : null
              }
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 160 }}>Ticket</th>
                      <th>Subject</th>
                      <th style={{ width: 130 }}>Link</th>
                      <th style={{ width: 120 }}>Priority</th>
                      <th style={{ width: 140 }}>Status</th>
                      <th style={{ width: 120 }}>Opened</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.length === 0 && (
                      <EmptyRow cols={7}>
                        <Nothing text="No incidents linked yet. Link the tickets that share this root cause." />
                      </EmptyRow>
                    )}
                    {incidents.map((t) => (
                      <tr key={s(t.link_id)}>
                        <td className="td-cell-mono">{dash(t.ticket_number)}</td>
                        <td>
                          <div className="sd-subj-cell">
                            <span className="sd-subj">{dash(t.subject)}</span>
                            <span className="sub muted">{label(t.ticket_type)}</span>
                          </div>
                        </td>
                        <td>
                          <ToneChip tone="link">{LINK_TYPE_LABEL[s(t.link_type).toUpperCase()] ?? label(t.link_type)}</ToneChip>
                        </td>
                        <td>
                          <PriorityChip value={t.priority} compact />
                        </td>
                        <td>{label(t.status)}</td>
                        <td className="muted">{fmtAgo(t.opened_at)}</td>
                        <td>
                          <div className="sd-row-act">
                            <button className="btn btn-sm" onClick={() => navigate('/service-desk/tickets/' + s(t.ticket_id))}>
                              Open
                            </button>
                            {perms.update ? (
                              <button
                                className="btn btn-sm sd-danger"
                                onClick={() => {
                                  setBusy(true);
                                  sdApi('/api/service-desk/problems/' + String(id) + '/incidents/' + s(t.ticket_id), { method: 'DELETE' })
                                    .then(refresh)
                                    .catch((e) => setError(e))
                                    .finally(() => setBusy(false));
                                }}
                                disabled={busy}
                              >
                                Unlink
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SecCard>
          ) : null}

          {panel === 'rca' ? (
            <SecCard
              title="Root cause analysis"
              sub="Structured investigation. An analysis must be submitted, then approved by someone other than its author."
              pad
              actions={
                perms.investigate ? (
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'rca' })}>
                    New analysis
                  </button>
                ) : null
              }
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 150 }}>Method</th>
                      <th>Root cause</th>
                      <th style={{ width: 140 }}>Status</th>
                      <th style={{ width: 160 }}>Author</th>
                      <th style={{ width: 120 }}>Created</th>
                      <th style={{ width: 200 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {analyses.length === 0 && (
                      <EmptyRow cols={6}>
                        <Nothing text="No root cause analysis yet." />
                      </EmptyRow>
                    )}
                    {analyses.map((a) => (
                      <tr key={s(a.id)}>
                        <td>{label(a.method)}</td>
                        <td>
                          <div className="sd-subj-cell">
                            <span className="sd-subj">{dash(a.root_cause).slice(0, 140)}</span>
                            <span className="sub muted">{dash(a.recommendation).slice(0, 140)}</span>
                          </div>
                        </td>
                        <td>
                          <RcaStatusChip value={a.status} />
                        </td>
                        <td className="muted">{dash(a.created_by_name)}</td>
                        <td className="muted">{fmtAgo(a.created_at)}</td>
                        <td>
                          <div className="sd-row-act">
                            <button className="btn btn-sm" onClick={() => void loadRca(s(a.id), setRcaView, setError)}>
                              View
                            </button>
                            {perms.investigate && s(a.status) === 'DRAFT' && s(a.created_by) === s(problem.created_by) ? null : null}
                            {perms.investigate && s(a.status) === 'DRAFT' ? (
                              <button
                                className="btn btn-sm"
                                disabled={busy}
                                onClick={() => {
                                  setBusy(true);
                                  sdPost('/api/service-desk/rcas/' + s(a.id) + '/submit', {})
                                    .then(refresh)
                                    .catch((e) => setError(e))
                                    .finally(() => setBusy(false));
                                }}
                              >
                                Submit
                              </button>
                            ) : null}
                            {perms.approveRca && s(a.status) === 'IN_REVIEW' ? (
                              <button className="btn btn-sm" onClick={() => setDlg({ kind: 'rcaReview', id: num(a.id) })}>
                                Review
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SecCard>
          ) : null}

          {panel === 'known' ? (
            <SecCard
              title="Known errors"
              sub="Agent-facing workarounds published against this problem."
              pad
              actions={
                perms.knownErrors ? (
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'createKe' })}>
                    New known error
                  </button>
                ) : null
              }
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 140 }}>Code</th>
                      <th>Title / symptoms</th>
                      <th style={{ width: 130 }}>Status</th>
                      <th style={{ width: 120 }}>Updated</th>
                      <th style={{ width: 140 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {knownErrors.length === 0 && (
                      <EmptyRow cols={5}>
                        <Nothing text="No known errors published for this problem." />
                      </EmptyRow>
                    )}
                    {knownErrors.map((k) => (
                      <tr key={s(k.id)}>
                        <td className="td-cell-mono">{dash(k.error_code)}</td>
                        <td>
                          <div className="sd-subj-cell">
                            <span className="sd-subj">{dash(k.title)}</span>
                            <span className="sub muted">{dash(k.symptoms).slice(0, 150)}</span>
                          </div>
                        </td>
                        <td>
                          <KnownErrorChip value={k.status} />
                        </td>
                        <td className="muted">{fmtAgo(k.updated_at)}</td>
                        <td>
                          {perms.knownErrors && s(k.status) !== 'ARCHIVED' ? (
                            <button
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => {
                                setBusy(true);
                                sdPost('/api/service-desk/known-errors/' + s(k.id) + '/archive', {})
                                  .then(refresh)
                                  .catch((e) => setError(e))
                                  .finally(() => setBusy(false));
                              }}
                            >
                              Archive
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SecCard>
          ) : null}

          {panel === 'history' ? (
            <SecCard title="Change history" sub="Who changed what, when, and from which value." pad>
              {history.length === 0 ? (
                <Nothing text="No history recorded." />
              ) : (
                <ol className="sd-timeline">
                  {history.map((h) => (
                    <li key={s(h.id)} className="sd-tl-item sd-tl-status">
                      <span className="sd-tl-dot" aria-hidden />
                      <div className="sd-tl-body">
                        <div className="sd-tl-top">
                          <b>{label(h.action)}</b>
                          <span className="muted">{fmtAgo(h.created_at)}</span>
                        </div>
                        {h.new_values ? (
                          <p className="sd-tl-text td-cell-mono">{JSON.stringify(h.new_values)}</p>
                        ) : null}
                        {h.old_values ? (
                          <p className="sd-tl-text td-cell-mono muted">was {JSON.stringify(h.old_values)}</p>
                        ) : null}
                        <span className="sd-tl-actor muted">
                          {dash(h.actor_name)} - {fmtDT(h.created_at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </SecCard>
          ) : null}
        </>
      )}

      {dlg ? (
        <ProblemDialogs
          dlg={dlg}
          problem={problem}
          busy={busy}
          error={dlgError}
          onClose={() => {
            setDlg(null);
            setDlgError('');
          }}
          act={act}
          onPatch={(payload: Rec) => {
            setBusy(true);
            setDlgError('');
            sdPatch('/api/service-desk/problems/' + String(id), payload)
              .then(() => {
                setDlg(null);
                refresh();
              })
              .catch((e) => setDlgError(sdErr(e)))
              .finally(() => setBusy(false));
          }}
          onLink={(payload: Rec) => {
            setBusy(true);
            setDlgError('');
            sdPost('/api/service-desk/problems/' + String(id) + '/incidents', payload)
              .then(() => {
                setDlg(null);
                refresh();
              })
              .catch((e) => setDlgError(sdErr(e)))
              .finally(() => setBusy(false));
          }}
          onRca={(payload: Rec) => {
            setBusy(true);
            setDlgError('');
            sdPost('/api/service-desk/problems/' + String(id) + '/rcas', payload)
              .then(() => {
                setDlg(null);
                refresh();
              })
              .catch((e) => setDlgError(sdErr(e)))
              .finally(() => setBusy(false));
          }}
          onReview={(rcaId: number, payload: Rec) => {
            setBusy(true);
            setDlgError('');
            sdPost('/api/service-desk/rcas/' + String(rcaId) + '/review', payload)
              .then(() => {
                setDlg(null);
                refresh();
              })
              .catch((e) => setDlgError(sdErr(e)))
              .finally(() => setBusy(false));
          }}
          onKnownError={(payload: Rec) => {
            setBusy(true);
            setDlgError('');
            sdPost('/api/service-desk/known-errors', payload)
              .then(() => {
                setDlg(null);
                refresh();
              })
              .catch((e) => setDlgError(sdErr(e)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}

      {rcaView ? (
        <Modal
          title={'Root cause analysis - ' + label(rcaView.method)}
          onClose={() => setRcaView(null)}
          wide
          footer={
            <button className="btn" onClick={() => setRcaView(null)}>
              Close
            </button>
          }
        >
          <div className="sd-facts">
            <Fact k="Status" v={<RcaStatusChip value={rcaView.status} />} />
            <Fact k="Author" v={dash(rcaView.created_by_name)} />
            <Fact k="Approved by" v={dash(rcaView.approved_by_name)} />
            <Fact k="Approved at" v={fmtDT(rcaView.approved_at)} />
          </div>
          <h4 className="sd-sub-head">Incident timeline</h4>
          <p className="sd-pre">{dash(rcaView.incident_timeline)}</p>
          <h4 className="sd-sub-head">Root cause</h4>
          <p className="sd-pre">{dash(rcaView.root_cause)}</p>
          <h4 className="sd-sub-head">Contributing factors</h4>
          <p className="sd-pre">{dash(rcaView.contributing_factors)}</p>
          <h4 className="sd-sub-head">Detection gap</h4>
          <p className="sd-pre">{dash(rcaView.detection_gap)}</p>
          <h4 className="sd-sub-head">Corrective actions</h4>
          <p className="sd-pre">{dash(rcaView.corrective_actions)}</p>
          <h4 className="sd-sub-head">Preventive actions</h4>
          <p className="sd-pre">{dash(rcaView.preventive_actions)}</p>
          <h4 className="sd-sub-head">Recommendation</h4>
          <p className="sd-pre">{dash(rcaView.recommendation)}</p>
        </Modal>
      ) : null}
    </>
  );
}

async function loadRca(id: unknown, set: (r: Rec) => void, setError: (e: unknown) => void) {
  try {
    const r = await sdApi<Rec>('/api/service-desk/rcas/' + s(id));
    set(r);
  } catch (e) {
    setError(e);
  }
}
/* ------------------------------------------------------------------ *
 * Problem dialogs
 * ------------------------------------------------------------------ */

const PRIORITY_OPTS = ['P1', 'P2', 'P3', 'P4'].map((v) => ({ value: v, label: v }));
const IMPACT_OPTS = ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR'].map((v) => ({ value: v, label: label(v) }));
const LINK_OPTS = ['TRIGGERING', 'MATCHED', 'MANUAL'].map((v) => ({ value: v, label: LINK_TYPE_LABEL[v] }));
const METHOD_OPTS = RCA_METHODS.map((v) => ({ value: v, label: label(v) }));
const YES_NO_OPTS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

type DlgBase = {
  problem: Rec;
  busy: boolean;
  error: string;
  onClose: () => void;
};

function DlgShell({
  title,
  sub,
  busy,
  error,
  onClose,
  onSubmit,
  submitLabel,
  wide,
  danger,
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
            disabled={busy}
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
      <FormErr msg={error} />
    </Modal>
  );
}

/** Agents come from the desk workload view so the picker never lists an
 *  unrelated employee. Failure is silent - assignment stays optional. */
function useAssignees(): Array<{ value: string; label: string }> {
  const [rows, setRows] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    let live = true;
    sdApi<Rec[]>('/api/service-desk/workload')
      .then((r) => {
        if (!live) return;
        const list = Array.isArray(r) ? r : [];
        setRows(list.map((u) => ({ value: s(u.user_id), label: dash(u.name) })));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return rows;
}

function EditDlg({ problem, busy, error, onClose, onPatch }: DlgBase & { onPatch: (p: Rec) => void }) {
  const [title, setTitle] = useState(s(problem.title));
  const [description, setDescription] = useState(s(problem.description));
  const [priority, setPriority] = useState('');
  const [impact, setImpact] = useState('');
  const [rootCause, setRootCause] = useState(s(problem.root_cause));
  const [workaround, setWorkaround] = useState(s(problem.workaround));
  const [permanentFix, setPermanentFix] = useState(s(problem.permanent_fix));
  return (
    <DlgShell
      title="Edit problem"
      sub="Only the fields you submit are written; the change is audited with old and new values."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Save changes"
      wide
      onSubmit={() =>
        onPatch({ title, description, priority, impact, rootCause, workaround, permanentFix })
      }
    >
      <Field label="Title" req>
        <Inp value={title} onChange={setTitle} />
      </Field>
      <Field label="Priority" hint="Leave as-is to keep the current priority">
        <Sel value={priority} onChange={setPriority} options={PRIORITY_OPTS} placeholder={'Keep ' + label(problem.priority)} />
      </Field>
      <Field label="Impact" hint="Leave as-is to keep the current impact">
        <Sel value={impact} onChange={setImpact} options={IMPACT_OPTS} placeholder={'Keep ' + label(problem.impact)} />
      </Field>
      <Field label="Description">
        <Txa value={description} onChange={setDescription} rows={4} />
      </Field>
      <Field label="Root cause">
        <Txa value={rootCause} onChange={setRootCause} rows={3} />
      </Field>
      <Field label="Workaround">
        <Txa value={workaround} onChange={setWorkaround} rows={3} />
      </Field>
      <Field label="Permanent fix">
        <Txa value={permanentFix} onChange={setPermanentFix} rows={3} />
      </Field>
    </DlgShell>
  );
}

function InvestigateDlg({ problem, busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [assignee, setAssignee] = useState(s(problem.assigned_to_user_id));
  const [note, setNote] = useState('');
  const [rootCause, setRootCause] = useState('');
  const people = useAssignees();
  return (
    <DlgShell
      title="Start investigation"
      sub="Moves the problem to Investigating and pins an owner for the root cause work."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Start investigation"
      onSubmit={() => act('/investigate', { assignedToUserId: assignee, note, rootCause })}
    >
      <Field label="Investigator" hint="Defaults to you when left empty">
        <Sel value={assignee} onChange={setAssignee} options={people} placeholder="Myself" />
      </Field>
      <Field label="First note">
        <Txa value={note} onChange={setNote} rows={3} />
      </Field>
      <Field label="Working root cause hypothesis">
        <Txa value={rootCause} onChange={setRootCause} rows={3} />
      </Field>
    </DlgShell>
  );
}

function RootCauseDlg({ busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [rootCause, setRootCause] = useState('');
  const [workaround, setWorkaround] = useState('');
  return (
    <DlgShell
      title="Record root cause"
      sub="Moves the problem to Root cause identified. The root cause becomes the audit note."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Record root cause"
      wide
      onSubmit={() => act('/root-cause', { rootCause, workaround })}
    >
      <Field label="Root cause" req>
        <Txa value={rootCause} onChange={setRootCause} rows={4} />
      </Field>
      <Field label="Workaround" hint="Optional interim relief while the permanent fix is prepared">
        <Txa value={workaround} onChange={setWorkaround} rows={3} />
      </Field>
    </DlgShell>
  );
}

function KnownErrorDlg({ problem, busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [workaround, setWorkaround] = useState(s(problem.workaround));
  const [rootCause, setRootCause] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [title, setTitle] = useState('');
  const [symptoms, setSymptoms] = useState('');
  return (
    <DlgShell
      title="Mark as known error"
      sub="A known error needs a workaround the desk can apply. Fill in the code or title to also publish an agent-facing known error record."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Mark as known error"
      wide
      onSubmit={() => act('/known-error', { workaround, rootCause, errorCode, title, symptoms })}
    >
      <Field label="Workaround" req>
        <Txa value={workaround} onChange={setWorkaround} rows={4} />
      </Field>
      <Field label="Root cause">
        <Txa value={rootCause} onChange={setRootCause} rows={3} />
      </Field>
      <Field label="Known error code" hint="Leave blank to auto-generate">
        <Inp value={errorCode} onChange={setErrorCode} placeholder="KE-HDG-PB-2026-000001" />
      </Field>
      <Field label="Known error title" hint="Fill this in to publish the known error record">
        <Inp value={title} onChange={setTitle} placeholder={'Defaults to ' + dash(problem.title)} />
      </Field>
      <Field label="Symptoms">
        <Txa value={symptoms} onChange={setSymptoms} rows={3} />
      </Field>
    </DlgShell>
  );
}

function ResolveDlg({ problem, busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [permanentFix, setPermanentFix] = useState('');
  const [rootCause, setRootCause] = useState(s(problem.root_cause));
  const [workaround, setWorkaround] = useState(s(problem.workaround));
  const [retire, setRetire] = useState('true');
  return (
    <DlgShell
      title="Resolve with permanent fix"
      sub="A permanent fix is mandatory: it is what separates a resolved problem from a repeated incident."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Resolve problem"
      wide
      onSubmit={() =>
        act('/resolve', { permanentFix, rootCause, workaround, resolveKnownErrors: retire === 'true' })
      }
    >
      <Field label="Permanent fix" req>
        <Txa value={permanentFix} onChange={setPermanentFix} rows={4} />
      </Field>
      <Field label="Root cause">
        <Txa value={rootCause} onChange={setRootCause} rows={3} />
      </Field>
      <Field label="Workaround">
        <Txa value={workaround} onChange={setWorkaround} rows={3} />
      </Field>
      <Field label="Retire active known errors" hint="Resolving retires the workaround records this fix replaces">
        <Sel value={retire} onChange={setRetire} options={YES_NO_OPTS} />
      </Field>
    </DlgShell>
  );
}

function CloseDlg({ busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [note, setNote] = useState('');
  const [force, setForce] = useState('false');
  return (
    <DlgShell
      title="Close problem"
      sub="Closing is blocked while linked incidents are still open, unless you force the closure."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Close problem"
      onSubmit={() => act('/close', { note, force: force === 'true' })}
    >
      <Field label="Closure note">
        <Txa value={note} onChange={setNote} rows={3} />
      </Field>
      <Field label="Force closure" hint="Only when the remaining incidents are handled elsewhere">
        <Sel value={force} onChange={setForce} options={YES_NO_OPTS} />
      </Field>
    </DlgShell>
  );
}

function CancelDlg({ busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [reason, setReason] = useState('');
  return (
    <DlgShell
      title="Cancel problem"
      sub="Cancelling records an audit reason. The problem stays in the register for traceability."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Cancel problem"
      danger
      onSubmit={() => act('/cancel', { reason })}
    >
      <Field label="Reason" req>
        <Txa value={reason} onChange={setReason} rows={3} />
      </Field>
    </DlgShell>
  );
}

function ReopenDlg({ busy, error, onClose, act }: DlgBase & { act: (p: string, b: Rec) => void }) {
  const [reason, setReason] = useState('');
  return (
    <DlgShell
      title="Reopen problem"
      sub="Reopening returns the problem to Investigating and clears the resolution stamps."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Reopen"
      onSubmit={() => act('/reopen', { reason })}
    >
      <Field label="Reason">
        <Txa value={reason} onChange={setReason} rows={3} />
      </Field>
    </DlgShell>
  );
}

function LinkDlg({ busy, error, onClose, onLink }: DlgBase & { onLink: (p: Rec) => void }) {
  const [ref, setRef] = useState('');
  const [linkType, setLinkType] = useState('MANUAL');
  return (
    <DlgShell
      title="Link incident"
      sub="Link the service ticket that contributed to this problem. Use the ticket number, for example HDG-SD-2026-000145."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Link incident"
      onSubmit={() => onLink({ ticketRef: ref.trim(), linkType })}
    >
      <Field label="Ticket number" req>
        <Inp value={ref} onChange={setRef} placeholder="HDG-SD-2026-000145" />
      </Field>
      <Field label="Link type">
        <Sel value={linkType} onChange={setLinkType} options={LINK_OPTS} />
      </Field>
    </DlgShell>
  );
}

function CreateKeDlg({ problem, busy, error, onClose, onKnownError }: DlgBase & { onKnownError: (p: Rec) => void }) {
  const [title, setTitle] = useState(s(problem.title));
  const [errorCode, setErrorCode] = useState('');
  const [symptoms, setSymptoms] = useState(s(problem.description));
  const [workaround, setWorkaround] = useState(s(problem.workaround));
  const [agentVisible, setAgentVisible] = useState('true');
  return (
    <DlgShell
      title="New known error"
      sub="Published to agents so the next occurrence is fixed on first contact."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Create known error"
      wide
      onSubmit={() =>
        onKnownError({
          problemId: num(problem.id),
          title,
          errorCode,
          symptoms,
          workaround,
          agentVisible: agentVisible === 'true',
        })
      }
    >
      <Field label="Title" req>
        <Inp value={title} onChange={setTitle} />
      </Field>
      <Field label="Error code" hint="Leave blank to auto-generate">
        <Inp value={errorCode} onChange={setErrorCode} placeholder="KE-HDG-PB-2026-000001" />
      </Field>
      <Field label="Symptoms">
        <Txa value={symptoms} onChange={setSymptoms} rows={4} />
      </Field>
      <Field label="Workaround" req>
        <Txa value={workaround} onChange={setWorkaround} rows={4} />
      </Field>
      <Field label="Visible to agents">
        <Sel value={agentVisible} onChange={setAgentVisible} options={YES_NO_OPTS} />
      </Field>
    </DlgShell>
  );
}

function RcaDlg({ problem, busy, error, onClose, onRca }: DlgBase & { onRca: (p: Rec) => void }) {
  const [method, setMethod] = useState('FIVE_WHYS');
  const [rootCause, setRootCause] = useState(s(problem.root_cause));
  const [timeline, setTimeline] = useState('');
  const [factors, setFactors] = useState('');
  const [gap, setGap] = useState('');
  const [corrective, setCorrective] = useState('');
  const [preventive, setPreventive] = useState('');
  const [recommendation, setRecommendation] = useState('');
  return (
    <DlgShell
      title="New root cause analysis"
      sub="Structured analysis is created as a draft; submit it for review when it is complete."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Create draft"
      wide
      onSubmit={() =>
        onRca({
          method,
          rootCause,
          incidentTimeline: timeline,
          contributingFactors: factors,
          detectionGap: gap,
          correctiveActions: corrective,
          preventiveActions: preventive,
          recommendation,
        })
      }
    >
      <Field label="Method">
        <Sel value={method} onChange={setMethod} options={METHOD_OPTS} />
      </Field>
      <Field label="Root cause">
        <Txa value={rootCause} onChange={setRootCause} rows={3} />
      </Field>
      <Field label="Incident timeline" hint="One event per line: when it started, what changed, when it was detected">
        <Txa value={timeline} onChange={setTimeline} rows={5} />
      </Field>
      <Field label="Contributing factors">
        <Txa value={factors} onChange={setFactors} rows={3} />
      </Field>
      <Field label="Detection gap" hint="Why was this not caught earlier?">
        <Txa value={gap} onChange={setGap} rows={3} />
      </Field>
      <Field label="Corrective actions">
        <Txa value={corrective} onChange={setCorrective} rows={3} />
      </Field>
      <Field label="Preventive actions">
        <Txa value={preventive} onChange={setPreventive} rows={3} />
      </Field>
      <Field label="Recommendation">
        <Txa value={recommendation} onChange={setRecommendation} rows={3} />
      </Field>
    </DlgShell>
  );
}

function RcaReviewDlg({ busy, error, onClose, id, onReview }: DlgBase & { id: number; onReview: (rcaId: number, b: Rec) => void }) {
  const [decision, setDecision] = useState('true');
  const [comments, setComments] = useState('');
  return (
    <DlgShell
      title="Review root cause analysis"
      sub="An approved analysis becomes the authoritative root cause on the problem."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel={decision === 'true' ? 'Approve analysis' : 'Reject analysis'}
      danger={decision !== 'true'}
      onSubmit={() => onReview(id, { approve: decision === 'true', comments })}
    >
      <Field label="Decision" req>
        <Sel value={decision} onChange={setDecision} options={YES_NO_OPTS} />
      </Field>
      <Field label="Review comments">
        <Txa value={comments} onChange={setComments} rows={4} />
      </Field>
    </DlgShell>
  );
}
/* ------------------------------------------------------------------ *
 * Problem dialog dispatch
 * ------------------------------------------------------------------ */

type ProblemDlgProps = DlgBase & {
  dlg: Exclude<Dlg, null>;
  act: (p: string, b: Rec) => void;
  onPatch: (b: Rec) => void;
  onLink: (b: Rec) => void;
  onRca: (b: Rec) => void;
  onReview: (rcaId: number, b: Rec) => void;
  onKnownError: (b: Rec) => void;
};

function ProblemDialogs(props: ProblemDlgProps) {
  const { dlg, problem, busy, error, onClose, act, onPatch, onLink, onRca, onReview, onKnownError } = props;
  const base: DlgBase = { problem, busy, error, onClose };
  switch (dlg.kind) {
    case 'edit':
      return <EditDlg {...base} onPatch={onPatch} />;
    case 'investigate':
      return <InvestigateDlg {...base} act={act} />;
    case 'rootCause':
      return <RootCauseDlg {...base} act={act} />;
    case 'knownError':
      return <KnownErrorDlg {...base} act={act} />;
    case 'resolve':
      return <ResolveDlg {...base} act={act} />;
    case 'close':
      return <CloseDlg {...base} act={act} />;
    case 'cancel':
      return <CancelDlg {...base} act={act} />;
    case 'reopen':
      return <ReopenDlg {...base} act={act} />;
    case 'link':
      return <LinkDlg {...base} onLink={onLink} />;
    case 'createKe':
      return <CreateKeDlg {...base} onKnownError={onKnownError} />;
    case 'rca':
      return <RcaDlg {...base} onRca={onRca} />;
    case 'rcaReview':
      return <RcaReviewDlg {...base} id={dlg.id} onReview={onReview} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Raise a problem
 * ------------------------------------------------------------------ */

function NewProblemDlg({
  categories,
  prefill,
  onClose,
  onCreated,
}: {
  categories: Rec[];
  prefill: { categoryId: string; subcategoryId: string; title: string; tickets: string };
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState(prefill.title);
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(prefill.categoryId);
  const [subcategoryId, setSubcategoryId] = useState(prefill.subcategoryId);
  const [priority, setPriority] = useState('');
  const [impact, setImpact] = useState('');
  const [tickets, setTickets] = useState(prefill.tickets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = categories.find((c) => s(c.id) === categoryId);
  const subs: Rec[] = chosen && Array.isArray(chosen.subcategories) ? (chosen.subcategories as Rec[]) : [];
  const subOptions = subs.map((x) => ({ value: s(x.id), label: s(x.name) }));
  const categoryOptions = categories.map((c) => ({ value: s(c.id), label: s(c.name) }));

  const submit = () => {
    setBusy(true);
    setError('');
    const payload: Rec = { title };
    if (description) payload.description = description;
    if (categoryId) payload.categoryId = num(categoryId);
    if (subcategoryId) payload.subcategoryId = num(subcategoryId);
    if (priority) payload.priority = priority;
    if (impact) payload.impact = impact;

    sdPost<Rec>('/api/service-desk/problems', payload)
      .then(async (r) => {
        const problem: Rec = (r?.problem as Rec) ?? {};
        const created = num(problem.id);
        const ref = s(problem.problem_number) || String(created);
        const refs = tickets
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter((x) => x.length > 0);
        for (const ticketRef of refs) {
          try {
            await sdPost('/api/service-desk/problems/' + ref + '/incidents', { ticketRef });
          } catch {
            // The problem exists; a failed back-link is reported in the register.
          }
        }
        onCreated(created);
      })
      .catch((e) => setError(sdErr(e)))
      .finally(() => setBusy(false));
  };

  return (
    <DlgShell
      title="New problem"
      sub="Group recurring incidents into one record so root cause and permanent fix are owned in a single place."
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel="Create problem"
      wide
      onSubmit={submit}
    >
      <Field label="Title" req>
        <Inp value={title} onChange={setTitle} placeholder="Recurring network dropouts on the first floor" />
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
        <Sel value={priority} onChange={setPriority} options={PRIORITY_OPTS} placeholder="Derived from impact" />
      </Field>
      <Field label="Impact">
        <Sel value={impact} onChange={setImpact} options={IMPACT_OPTS} placeholder="Individual" />
      </Field>
      <Field label="Description" hint="What keeps happening, how often, and who is affected">
        <Txa value={description} onChange={setDescription} rows={4} />
      </Field>
      <Field label="Link incidents" hint="Ticket numbers separated by commas or spaces. Linked after the problem is created.">
        <Txa value={tickets} onChange={setTickets} rows={2} placeholder="HDG-SD-2026-000145, HDG-SD-2026-000152" />
      </Field>
    </DlgShell>
  );
}

/* ------------------------------------------------------------------ *
 * Problems surface
 * ------------------------------------------------------------------ */

const PROBLEM_TABS: Array<[string, string]> = [
  ['register', 'Problem register'],
  ['candidates', 'Recurring incidents'],
  ['known-errors', 'Known errors'],
];

export default function ServiceDeskProblems({ id }: { id?: number | null }) {
  const q = useHashQuery();
  const [tab, setTab] = useState<string>(() => {
    const t = s(q.get('tab'));
    return PROBLEM_TABS.some(([k]) => k === t) ? t : 'register';
  });
  const [dashboard, setDashboard] = useState<Rec | null>(null);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [creating, setCreating] = useState(false);

  const wantNew = s(q.get('new')) === '1';

  useEffect(() => {
    const t = s(q.get('tab'));
    if (t && PROBLEM_TABS.some(([k]) => k === t)) setTab(t);
  }, [q]);

  useEffect(() => {
    setCreating(wantNew);
  }, [wantNew]);

  useEffect(() => {
    let live = true;
    sdApi<Rec>('/api/service-desk/problems/dashboard')
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
  }, []);

  if (id) return <ProblemDetail id={id} />;

  const scope: Rec = (dashboard?.scope as Rec) ?? {};
  const canCreate = !!scope.canCreate;

  const closeNew = () => {
    setCreating(false);
    if (wantNew) navigate('/service-desk/problems');
  };

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title="Problem management"
        kicker="Service desk - ITSM"
        sub="Multiple incidents, one problem: pattern detection, root cause analysis, known errors and a permanent fix."
        actions={
          canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New problem
            </button>
          ) : null
        }
      />
      <SdTabs active="problems" />

      {dashboard ? (
        <KpiRow>
          <KpiTile
            label="Open problems"
            value={num(dashboard.openProblems)}
            sub={num(dashboard.unassignedProblems) + ' unassigned'}
          />
          <KpiTile
            label="Awaiting closure"
            value={num(dashboard.resolvedAwaitingClosure)}
            sub="Resolved, not yet closed"
          />
          <KpiTile
            label="Known errors"
            value={num(dashboard.knownErrors)}
            sub={num(dashboard.activeKnownErrors) + ' active'}
          />
          <KpiTile label="Assigned to me" value={num(dashboard.myProblems)} sub="Open problems I own" />
          <KpiTile
            label="Average time to resolve"
            value={dash(dashboard.averageDaysToResolution) + ' d'}
            sub="Closed problems in scope"
          />
        </KpiRow>
      ) : null}

      <div className="tabs sd-sub-tabs">
        {PROBLEM_TABS.map(([key, text]) => (
          <button
            key={key}
            className={key === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === 'register' ? <ProblemsList canCreate={canCreate} categories={categories} /> : null}
      {tab === 'candidates' ? <CandidatesPanel canCreate={canCreate} /> : null}
      {tab === 'known-errors' ? <KnownErrorsPanel /> : null}

      {creating ? (
        <NewProblemDlg
          categories={categories}
          prefill={{
            categoryId: s(q.get('categoryId')),
            subcategoryId: s(q.get('subcategoryId')),
            title: s(q.get('title')),
            tickets: s(q.get('tickets')),
          }}
          onClose={closeNew}
          onCreated={(newId) => {
            setCreating(false);
            navigate('/service-desk/problems/' + String(newId));
          }}
        />
      ) : null}
    </div>
  );
}
