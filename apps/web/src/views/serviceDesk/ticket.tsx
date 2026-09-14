import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, Spinner } from '../../components/ui';
import { Field, Inp, Sel, Txa } from '../hikvision/fields';
import {
  ActivityFeed,
  AttachmentList,
  CommentList,
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  SlaMeter,
  StatusChip,
  TagList,
  dash,
  fmtAgo,
  fmtDT,
  fmtDur,
  isOpenStatus,
  label,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  sdPatch,
  sdPost,
  subjectOf,
  ticketRef,
  useSdMeta,
  type ActivityItem,
  type Rec,
} from '../serviceDeskShared';

export interface Bundle {
  ticket: Rec;
  sla: Rec | null;
  asset: Rec | null;
  comments: Rec[];
  attachments: Rec[];
  escalations: Rec[];
  related: Rec[];
  knowledge: Rec[];
  activity: ActivityItem[];
  permissions: {
    canViewInternalNotes?: boolean;
    isRequester?: boolean;
    isAgent?: boolean;
    isAdmin?: boolean;
  };
}

export function detailPath(id: unknown, agent: boolean): string {
  return (agent ? '/api/service-desk/tickets/' : '/api/my/service-desk/tickets/') + s(id);
}

export async function loadBundle(id: unknown, agent: boolean): Promise<Bundle> {
  return sdApi<Bundle>(detailPath(id, agent) + '?withComments=true&withActivity=true');
}

export function useAgentSurface(): boolean {
  const { user } = useAuth();
  return can(user, 'service_desk.tickets.view');
}

/* ------------------------------------------------------------------ *
 * Small dialogs
 * ------------------------------------------------------------------ */

export function ReasonDialog({
  title,
  labelText,
  hint,
  confirm,
  danger,
  extra,
  onClose,
  onSubmit,
}: {
  title: string;
  labelText: string;
  hint?: string;
  confirm: string;
  danger?: boolean;
  extra?: React.ReactNode;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!reason.trim()) {
      setError('A written reason is required and is written to the audit trail.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : confirm}
          </button>
        </>
      }
    >
      {extra}
      <Field label={labelText} req hint={hint}>
        <Txa value={reason} onChange={setReason} rows={3} />
      </Field>
      {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

export function AssignDialog({
  ticket,
  strategies,
  defaultQueueId,
  reassign,
  onClose,
  onDone,
}: {
  ticket: Rec;
  strategies: string[];
  defaultQueueId?: number | null;
  reassign?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [queues, setQueues] = useState<Rec[]>([]);
  const [people, setPeople] = useState<Rec[]>([]);
  const [queueId, setQueueId] = useState(s(defaultQueueId ?? ticket.assigned_queue_id ?? ''));
  const [userId, setUserId] = useState(s(ticket.assigned_to_user_id ?? ''));
  const [strategy, setStrategy] = useState(reassign ? 'MANUAL' : s(ticket.assignment_strategy) || 'MANUAL');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/queues').then((r) => setQueues(Array.isArray(r) ? r : [])).catch(() => setQueues([]));
    sdApi<Rec[]>('/api/service-desk/workload').then((r) => setPeople(Array.isArray(r) ? r : [])).catch(() => setPeople([]));
  }, []);

  const go = async () => {
    if (!queueId && !userId && strategy === 'MANUAL') {
      setError('Pick a queue, a technician or an assignment strategy.');
      return;
    }
    if ((reassign || strategy === 'MANUAL') && !reason.trim()) {
      setError('Reassignment and manual assignment need a reason for the audit trail.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload: Rec = { strategy, reason: reason.trim() || undefined };
      if (queueId) payload.queueId = num(queueId);
      if (userId) payload.assignedToUserId = num(userId);
      await sdPost('/api/service-desk/tickets/' + s(ticket.id) + (reassign ? '/reassign' : '/assign'), payload);
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={reassign ? 'Reassign ticket' : 'Assign ticket'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : reassign ? 'Reassign' : 'Assign'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <div className="sd-form-row">
          <Field label="Assignment strategy" hint="Round robin, load balanced and skill based are applied by the desk automatically.">
            <Sel
              value={strategy}
              onChange={setStrategy}
              options={strategies.map((v) => ({ value: v, label: label(v) }))}
            />
          </Field>
          <Field label="Queue" hint="Leave blank to keep the ticket on its current queue.">
            <Sel
              value={queueId}
              onChange={setQueueId}
              options={queues.map((q) => ({
                value: s(q.id),
                label: s(q.name) + (num(q.open_tickets) ? ' (' + num(q.open_tickets) + ' open)' : ''),
              }))}
              placeholder="Keep current queue"
            />
          </Field>
        </div>
        <Field label="Technician" hint="Empty leaves the ticket in the queue for the next available agent.">
          <Sel
            value={userId}
            onChange={setUserId}
            options={people.map((p) => ({
              value: s(p.user_id),
              label: s(p.name) + ' - ' + num(p.open_tickets) + ' open, ' + num(p.critical_tickets) + ' critical',
            }))}
            placeholder="Unassigned (queue picks it up)"
          />
        </Field>
        <Field label="Reason" req={reassign || strategy === 'MANUAL'} hint="Recorded in the audit trail as the assignment history entry.">
          <Txa value={reason} onChange={setReason} rows={2} />
        </Field>
      </div>
      {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
/* ------------------------------------------------------------------ *
 * Composer - public reply vs internal note (spec 11)
 * ------------------------------------------------------------------ */

export function Composer({
  ticketId,
  surface,
  canInternal,
  onPosted,
}: {
  ticketId: unknown;
  surface: 'agent' | 'my';
  canInternal: boolean;
  onPosted: () => void;
}) {
  const [mode, setMode] = useState<'public' | 'internal'>('public');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const internal = mode === 'internal';

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (surface === 'my') {
        await sdPost('/api/my/service-desk/tickets/' + s(ticketId) + '/reply', { body: body.trim() });
      } else {
        await sdPost(
          '/api/service-desk/tickets/' + s(ticketId) + (internal ? '/notes' : '/respond'),
          { body: body.trim(), isInternal: internal }
        );
      }
      setBody('');
      onPosted();
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={'sd-composer' + (internal ? ' sd-composer-internal' : '')}>
      {canInternal && (
        <div className="sd-composer-modes">
          <button
            type="button"
            className={mode === 'public' ? 'chip active' : 'chip'}
            onClick={() => setMode('public')}
          >
            Public reply
          </button>
          <button
            type="button"
            className={mode === 'internal' ? 'chip active' : 'chip'}
            onClick={() => setMode('internal')}
          >
            Internal note
          </button>
          <span className="muted">
            {internal
              ? 'Only service desk agents and authorised managers can read this.'
              : 'Visible to the requester and authorised service personnel.'}
          </span>
        </div>
      )}
      {!canInternal && (
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
          Your reply is visible to the service desk and to you.
        </p>
      )}
      <Txa value={body} onChange={setBody} rows={4} placeholder={internal ? 'Work notes, diagnostics, vendor reference...' : 'Write a reply...'} />
      <div className="sd-composer-foot">
        <span className={'sd-vis-tag ' + (internal ? 'internal' : 'public')}>
          {internal ? 'Internal note' : 'Public reply'}
        </span>
        <button className={'btn btn-primary sd-primary'} onClick={() => void send()} disabled={busy || !body.trim()}>
          {busy ? <Spinner /> : internal ? 'Add note' : 'Send reply'}
        </button>
      </div>
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

function AttachmentsPanel({
  ticketId,
  surface,
  items,
  onChanged,
}: {
  ticketId: unknown;
  surface: 'agent' | 'my';
  items: Rec[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = surface === 'my' ? '/api/my/service-desk/tickets/' : '/api/service-desk/tickets/';

  const upload = async (f: File | null) => {
    if (!f) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      await sdApi(base + s(ticketId) + '/attachments', { method: 'POST', body: fd });
      onChanged();
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AttachmentList items={items} />
      <div className="sd-attach-foot">
        <input type="file" className="sd-file-input" onChange={(e) => void upload(e.target.files?.[0] ?? null)} disabled={busy} />
        {busy && <Spinner />}
      </div>
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Relations + linked knowledge
 * ------------------------------------------------------------------ */

function RelationsPanel({
  ticketId,
  related,
  relationTypes,
  canEdit,
  onChanged,
}: {
  ticketId: unknown;
  related: Rec[];
  relationTypes: string[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [relationType, setRelationType] = useState(relationTypes[0] ?? 'RELATED');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    if (!target.trim()) return;
    setBusy(true);
    setError('');
    try {
      await sdPost('/api/service-desk/tickets/' + s(ticketId) + '/relations', {
        relationType,
        relatedTicketId: num(target.trim()),
      });
      setTarget('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (relationId: unknown) => {
    try {
      await sdApi('/api/service-desk/tickets/' + s(ticketId) + '/relations/' + s(relationId), { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(sdErr(e));
    }
  };

  return (
    <>
      {related.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No related tickets.</p>
      ) : (
        <ul className="sd-rel">
          {related.map((r) => (
            <li key={s(r.relation_id ?? r.id)}>
              <span className="chip">{label(r.relation_type)}</span>
              <button className="link-btn td-cell-mono" onClick={() => navigate('/service-desk/t/' + s(r.ticket_id ?? r.id))}>
                {dash(r.ticket_number ?? r.ticket_id)}
              </button>
              <span className="sd-rel-subj">{dash(r.subject)}</span>
              <StatusChip value={r.status} />
              {canEdit && (
                <button className="btn btn-sm" onClick={() => void remove(r.relation_id ?? r.id)}>Unlink</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="sd-panel-foot">
          {open ? (
            <div className="sd-form-row">
              <Field label="Relationship">
                <Sel value={relationType} onChange={setRelationType} options={relationTypes.map((v) => ({ value: v, label: label(v) }))} />
              </Field>
              <Field label="Ticket ID" hint="Numeric id of the other ticket">
                <Inp value={target} onChange={setTarget} placeholder="e.g. 145" />
              </Field>
              <div className="sd-inline-actions">
                <button className="btn btn-primary" onClick={() => void add()} disabled={busy || !target.trim()}>Link</button>
                <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-sm" onClick={() => setOpen(true)}>+ Link a ticket</button>
          )}
        </div>
      )}
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

function KnowledgeLinks({
  ticketId,
  linked,
  canEdit,
  onChanged,
}: {
  ticketId: unknown;
  linked: Rec[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRecs = useCallback(async () => {
    try {
      const r = await sdApi<{ items?: Rec[] }>('/api/service-desk/tickets/' + s(ticketId) + '/recommendations');
      setRecs(Array.isArray(r?.items) ? r.items : []);
    } catch {
      setRecs([]);
    }
  }, [ticketId]);

  useEffect(() => void loadRecs(), [loadRecs]);

  const link = async (articleId: unknown) => {
    setBusy(true);
    try {
      await sdPost('/api/service-desk/tickets/' + s(ticketId) + '/knowledge', { articleId: num(articleId) });
      onChanged();
      setError('');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (articleId: unknown) => {
    try {
      await sdApi('/api/service-desk/tickets/' + s(ticketId) + '/knowledge/' + s(articleId), { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(sdErr(e));
    }
  };

  return (
    <>
      {linked.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No knowledge articles linked yet.</p>
      ) : (
        <ul className="sd-kb-links">
          {linked.map((k) => (
            <li key={s(k.article_id ?? k.id)}>
              <button className="link-btn" onClick={() => navigate('/service-desk/knowledge/' + s(k.article_id ?? k.id))}>
                {dash(k.title)}
              </button>
              <span className="muted">{dash(k.article_no ?? k.code)}</span>
              {canEdit && (
                <button className="btn btn-sm" onClick={() => void unlink(k.article_id ?? k.id)}>Unlink</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {recs.length > 0 && (
        <>
          <p className="sd-panel-title muted">Suggested from the knowledge base</p>
          <ul className="sd-kb-links">
            {recs.slice(0, 5).map((k) => (
              <li key={s(k.id)}>
                <span>{dash(k.title)}</span>
                <span className="muted">{num(k.score ?? k.rank) ? 'match ' + num(k.score ?? k.rank) : dash(k.article_no)}</span>
                {canEdit && (
                  <button className="btn btn-sm" onClick={() => void link(k.id)} disabled={busy}>Link</button>
                )}
                <button className="link-btn" onClick={() => navigate('/service-desk/knowledge/' + s(k.id))}>Open</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}
/* ------------------------------------------------------------------ *
 * Lifecycle actions - spec 8
 * ------------------------------------------------------------------ */

export type SdActionKey =
  | 'OPEN'
  | 'START'
  | 'PENDING'
  | 'RESOLVE'
  | 'CLOSE'
  | 'REOPEN'
  | 'CANCEL'
  | 'CONFIRM'
  | 'ESCALATE';

export interface SdActionSpec {
  key: SdActionKey;
  text: string;
  from: string[];
  perms: string[];
  surfaces: Array<'agent' | 'my'>;
  danger?: boolean;
  primary?: boolean;
  requesterOnly?: boolean;
}

export const SD_ACTION_SPECS: SdActionSpec[] = [
  {
    key: 'OPEN',
    text: 'Open ticket',
    from: ['NEW'],
    perms: ['service_desk.tickets.update'],
    surfaces: ['agent'],
    primary: true,
  },
  {
    key: 'START',
    text: 'Start work',
    from: ['OPEN', 'ASSIGNED', 'ESCALATED', 'REOPENED', 'PENDING_REQUESTER', 'PENDING_VENDOR'],
    perms: ['service_desk.tickets.update'],
    surfaces: ['agent'],
    primary: true,
  },
  {
    key: 'PENDING',
    text: 'Put on hold',
    from: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED'],
    perms: ['service_desk.tickets.update'],
    surfaces: ['agent'],
  },
  {
    key: 'RESOLVE',
    text: 'Resolve',
    from: [
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'ESCALATED',
      'REOPENED',
      'PENDING_REQUESTER',
      'PENDING_VENDOR',
    ],
    perms: ['service_desk.tickets.resolve'],
    surfaces: ['agent'],
    primary: true,
  },
  {
    key: 'CLOSE',
    text: 'Close',
    from: ['RESOLVED'],
    perms: ['service_desk.tickets.close', 'service_desk.tickets.close_own'],
    surfaces: ['agent', 'my'],
  },
  {
    key: 'REOPEN',
    text: 'Reopen',
    from: ['RESOLVED', 'CLOSED', 'CANCELLED'],
    perms: ['service_desk.tickets.reopen', 'service_desk.tickets.close_own'],
    surfaces: ['agent', 'my'],
  },
  {
    key: 'CANCEL',
    text: 'Cancel ticket',
    from: ['NEW', 'OPEN', 'ASSIGNED'],
    perms: ['service_desk.tickets.close', 'service_desk.tickets.close_own'],
    surfaces: ['agent', 'my'],
    danger: true,
  },
  {
    key: 'CONFIRM',
    text: 'Confirm resolution',
    from: ['RESOLVED'],
    perms: ['service_desk.tickets.verify', 'service_desk.tickets.close_own'],
    surfaces: ['my'],
    requesterOnly: true,
    primary: true,
  },
  {
    key: 'ESCALATE',
    text: 'Escalate',
    from: [
      'NEW',
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'PENDING_REQUESTER',
      'PENDING_VENDOR',
      'ESCALATED',
      'REOPENED',
    ],
    perms: ['service_desk.tickets.escalate'],
    surfaces: ['agent'],
    danger: true,
  },
];

export function actionsFor(
  status: unknown,
  surface: 'agent' | 'my',
  ctx: { isRequester: boolean; can: (p: string) => boolean }
): SdActionSpec[] {
  const st = s(status).toUpperCase();
  return SD_ACTION_SPECS.filter((a) => {
    if (a.surfaces.indexOf(surface) < 0) return false;
    if (a.from.indexOf(st) < 0) return false;
    if (a.requesterOnly && !ctx.isRequester) return false;
    return a.perms.some((p) => ctx.can(p));
  });
}

export function ticketBase(agent: boolean, id: unknown): string {
  return (agent ? '/api/service-desk/tickets/' : '/api/my/service-desk/tickets/') + s(id);
}

/* ------------------------------------------------------------------ *
 * Lifecycle dialogs
 * ------------------------------------------------------------------ */

export function SimpleNoteDialog({
  title,
  confirm,
  labelText,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  confirm: string;
  labelText: string;
  hint?: string;
  onSubmit: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(note.trim());
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary sd-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : confirm}
          </button>
        </>
      }
    >
      <Field label={labelText} hint={hint}>
        <Txa value={note} onChange={setNote} rows={3} />
      </Field>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

export function PendingDialog({
  ticketId,
  onClose,
  onDone,
}: {
  ticketId: unknown;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('PENDING_REQUESTER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!reason.trim()) {
      setError('A reason is required and is written to the audit trail.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await sdPost('/api/service-desk/tickets/' + s(ticketId) + '/pending', {
        reason: reason.trim(),
        status,
      });
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Put ticket on hold"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : 'Put on hold'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <Field
          label="Waiting on"
          hint="Response and resolution timers may be paused while a ticket is on hold, per the SLA policy."
        >
          <Sel
            value={status}
            onChange={setStatus}
            options={[
              { value: 'PENDING_REQUESTER', label: 'Requester - waiting for information' },
              { value: 'PENDING_VENDOR', label: 'Vendor or third party' },
            ]}
          />
        </Field>
        <Field label="Reason" req hint="Recorded against the ticket and in the audit trail.">
          <Txa value={reason} onChange={setReason} rows={3} />
        </Field>
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

export function ResolveDialog({
  ticketId,
  codes,
  onClose,
  onDone,
}: {
  ticketId: unknown;
  codes: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [code, setCode] = useState(codes[0] ?? 'FIXED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!summary.trim()) {
      setError('A resolution summary is required - it is shown to the requester.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await sdPost('/api/service-desk/tickets/' + s(ticketId) + '/resolve', {
        resolutionSummary: summary.trim(),
        resolutionCode: code,
      });
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Resolve ticket"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary sd-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : 'Resolve'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <Field
          label="Resolution summary"
          req
          hint="What was done, in plain language the requester can understand."
        >
          <Txa value={summary} onChange={setSummary} rows={4} />
        </Field>
        <Field label="Resolution code" hint="Lets reporting separate real fixes from workarounds.">
          <Sel
            value={code}
            onChange={setCode}
            options={codes.map((c) => ({ value: c, label: label(c) }))}
          />
        </Field>
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

export function EscalateDialog({
  ticketId,
  currentLevel,
  onClose,
  onDone,
}: {
  ticketId: unknown;
  currentLevel?: unknown;
  onClose: () => void;
  onDone: () => void;
}) {
  const [levels, setLevels] = useState<Rec[]>([]);
  const [levelId, setLevelId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/escalation/levels')
      .then((r) => setLevels(Array.isArray(r) ? r : []))
      .catch(() => setLevels([]));
  }, []);

  const go = async () => {
    if (!reason.trim()) {
      setError('An escalation reason is required and is written to the audit trail.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload: Rec = { reason: reason.trim() };
      if (levelId) payload.levelId = num(levelId);
      await sdPost('/api/service-desk/tickets/' + s(ticketId) + '/escalate', payload);
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Escalate ticket"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : 'Escalate'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <Field
          label="Escalation level"
          hint={
            currentLevel
              ? 'Currently at level ' + s(currentLevel) + '. Leave blank to move up one level.'
              : 'Leave blank to use the configured escalation rule for this category and priority.'
          }
        >
          <Sel
            value={levelId}
            onChange={setLevelId}
            placeholder="Use the configured rule"
            options={levels.map((l) => ({
              value: s(l.id),
              label:
                'Level ' +
                num(l.level) +
                ' - ' +
                s(l.name) +
                (s(l.role_code) ? ' (' + label(l.role_code) + ')' : ''),
            }))}
          />
        </Field>
        <Field label="Reason" req hint="Sent with the escalation notification.">
          <Txa value={reason} onChange={setReason} rows={3} />
        </Field>
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

export function ConfirmResolutionDialog({
  base,
  onClose,
  onDone,
}: {
  base: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [rating, setRating] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const payload: Rec = {};
      if (note.trim()) payload.note = note.trim();
      if (rating) payload.satisfactionRating = num(rating);
      await sdPost(base + '/confirm', payload);
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Confirm the fix worked"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Not yet
          </button>
          <button className="btn btn-primary sd-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : 'Confirm'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <Field label="How did we do?" hint="Your rating is used to measure service quality.">
          <Sel
            value={rating}
            onChange={setRating}
            placeholder="No rating"
            options={[
              { value: '5', label: '5 - Excellent' },
              { value: '4', label: '4 - Good' },
              { value: '3', label: '3 - Acceptable' },
              { value: '2', label: '2 - Poor' },
              { value: '1', label: '1 - Very poor' },
            ]}
          />
        </Field>
        <Field label="Comment" hint="Optional - anything that would help us improve.">
          <Txa value={note} onChange={setNote} rows={3} />
        </Field>
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
/* ------------------------------------------------------------------ *
 * Ticket detail - spec 9, 11, 12, 17, 29
 * ------------------------------------------------------------------ */

type Panel =
  | 'activity'
  | 'conversation'
  | 'details'
  | 'asset'
  | 'related'
  | 'knowledge'
  | 'escalations';

const PANELS: Array<[Panel, string]> = [
  ['activity', 'Activity'],
  ['conversation', 'Conversation'],
  ['details', 'Details'],
  ['asset', 'Affected asset'],
  ['related', 'Related tickets'],
  ['knowledge', 'Knowledge'],
  ['escalations', 'Escalations'],
];

function asPanel(v: string): Panel {
  const hit = PANELS.filter(([k]) => k === v)[0];
  return hit ? hit[0] : 'activity';
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function EditTicketDialog({
  ticket,
  priorities,
  impacts,
  urgencies,
  canOverride,
  onClose,
  onDone,
}: {
  ticket: Rec;
  priorities: string[];
  impacts: string[];
  urgencies: string[];
  canOverride: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [subject, setSubject] = useState(s(ticket.subject));
  const [description, setDescription] = useState(s(ticket.description));
  const [priority, setPriority] = useState(s(ticket.priority));
  const [impact, setImpact] = useState(s(ticket.impact) || 'INDIVIDUAL');
  const [urgency, setUrgency] = useState(s(ticket.urgency) || 'MEDIUM');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const priorityChanged = priority !== s(ticket.priority);
  const derived =
    impact === 'ENTERPRISE' || urgency === 'CRITICAL'
      ? 'P1'
      : impact === 'DEPARTMENT' || urgency === 'HIGH'
        ? 'P2'
        : impact === 'MINOR' && urgency === 'LOW'
          ? 'P4'
          : 'P3';

  const go = async () => {
    if (priorityChanged && canOverride && !reason.trim()) {
      setError('Overriding the calculated priority needs a written reason for the audit trail.');
      return;
    }
    const payload: Rec = {};
    if (subject !== s(ticket.subject)) payload.subject = subject.trim();
    if (description !== s(ticket.description)) payload.description = description;
    if (impact !== s(ticket.impact)) payload.impact = impact;
    if (urgency !== s(ticket.urgency)) payload.urgency = urgency;
    if (priorityChanged) {
      payload.priority = priority;
      if (canOverride) payload.priorityOverrideReason = reason.trim();
    }
    if (Object.keys(payload).length === 0) {
      setError('Nothing has changed.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await sdPatch('/api/service-desk/tickets/' + s(ticket.id), payload);
      onDone();
    } catch (e) {
      setError(sdErr(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={'Edit ' + ticketRef(ticket)}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner /> : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="sd-form">
        <Field label="Subject" req hint="Maximum 200 characters.">
          <Inp value={subject} onChange={setSubject} maxLength={200} />
        </Field>
        <Field label="Description">
          <Txa value={description} onChange={setDescription} rows={5} />
        </Field>
        <div className="sd-form-row">
          <Field label="Impact">
            <Sel
              value={impact}
              onChange={setImpact}
              options={impacts.map((v) => ({ value: v, label: label(v) }))}
            />
          </Field>
          <Field label="Urgency">
            <Sel
              value={urgency}
              onChange={setUrgency}
              options={urgencies.map((v) => ({ value: v, label: label(v) }))}
            />
          </Field>
        </div>
        <div className="sd-prio-preview">
          <span className="muted">Impact + urgency calculates</span>
          <PriorityChip value={derived} />
          <span className="muted">- the priority below is the value that will be saved.</span>
        </div>
        <Field
          label="Priority"
          hint={
            canOverride
              ? 'Manual override is permitted for your role and is always audited.'
              : 'Without override rights the calculated priority is applied automatically.'
          }
        >
          <Sel
            value={priority}
            onChange={setPriority}
            options={priorities.map((v) => ({ value: v, label: label(v) }))}
          />
        </Field>
        {priorityChanged && canOverride && (
          <Field label="Override reason" req hint="Recorded in the audit trail with the previous and new value.">
            <Txa value={reason} onChange={setReason} rows={2} />
          </Field>
        )}
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

export default function TicketDetail({
  id,
  agent: agentProp,
  embedded,
}: {
  id: number;
  agent?: boolean;
  embedded?: boolean;
}) {
  const { user } = useAuth();
  const q = useHashQuery();
  const agent = agentProp === true || (agentProp === undefined && can(user, 'service_desk.tickets.view'));
  const surface: 'agent' | 'my' = agent ? 'agent' : 'my';
  const meta = useSdMeta();

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [panel, setPanel] = useState<Panel>(asPanel(s(q.get('panel'))));
  const [dialog, setDialog] = useState<SdActionKey | 'ASSIGN' | 'REASSIGN' | 'EDIT' | null>(null);

  const refresh = useCallback(() => setTick((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadBundle(id, agent)
      .then((b) => {
        if (!alive) return;
        setBundle(b);
        setError('');
      })
      .catch((e) => {
        if (alive) setError(sdErr(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, agent, tick]);

  const ticket = bundle?.ticket ?? null;
  const perms = bundle?.permissions ?? {};
  const base = ticketBase(agent, id);

  const actions = useMemo(
    () =>
      actionsFor(ticket?.status, surface, {
        isRequester: Boolean(perms.isRequester),
        can: (p) => can(user, p),
      }),
    [ticket?.status, surface, perms.isRequester, user]
  );

  const canAssign = agent && can(user, 'service_desk.tickets.assign');
  const canEdit = agent && can(user, 'service_desk.tickets.update');
  const canInternal = Boolean(perms.canViewInternalNotes);
  const levels = ticket ? s(ticket.escalation_level) : '';

  const runAction = async (key: SdActionKey, payload?: Rec) => {
    await sdPost(base + '/' + key.toLowerCase(), payload ?? {});
    setDialog(null);
    refresh();
  };

  if (loading && !bundle) {
    return (
      <div className="center-box">
        <Spinner />
      </div>
    );
  }

  if (error && !ticket) {
    return (
      <div className={embedded ? '' : 'page'} style={modStyle()}>
        <ErrorBanner error={error} />
      </div>
    );
  }

  if (!ticket) return null;

  const asset = bundle?.asset ?? null;
  const related = bundle?.related ?? [];
  const knowledge = bundle?.knowledge ?? [];
  const escalations = bundle?.escalations ?? [];
  const open = isOpenStatus(ticket.status);

  const detail = (
    <div className="sd-detail">
      <div className="sd-detail-head">
        <div className="sd-detail-title">
          <span className="td-cell-mono sd-detail-ref">{ticketRef(ticket)}</span>
          <h2>{subjectOf(ticket)}</h2>
          <div className="chips">
            <PriorityChip value={ticket.priority} />
            <StatusChip value={ticket.status} />
            <span className="chip">{label(ticket.ticket_type)}</span>
            {ticket.priority_overridden ? <span className="chip">Priority overridden</span> : null}
          </div>
        </div>
        <div className="sd-detail-who">
          <div>
            <span className="muted">Requester</span>
            <b>{dash(ticket.requester_name)}</b>
            <span className="sub muted td-cell-mono">{dash(ticket.requester_employee_no)}</span>
          </div>
          <div>
            <span className="muted">Assigned</span>
            <b>{s(ticket.assignee_name) || 'Unassigned'}</b>
            <span className="sub muted">{dash(ticket.queue_name)}</span>
          </div>
          <div>
            <span className="muted">Opened</span>
            <b>{fmtAgo(ticket.opened_at ?? ticket.created_at)}</b>
            <span className="sub muted">{fmtDT(ticket.opened_at ?? ticket.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="sd-actionbar">
        {actions.map((a) => (
          <button
            key={a.key}
            className={
              'btn ' + (a.danger ? 'btn-danger' : a.primary ? 'btn-primary sd-primary' : '')
            }
            onClick={() => {
              if (a.key === 'OPEN' || a.key === 'START') void runAction(a.key, {});
              else setDialog(a.key);
            }}
          >
            {a.text}
          </button>
        ))}
        {canAssign && (
          <>
            <button className="btn" onClick={() => setDialog(ticket.assigned_to_user_id ? 'REASSIGN' : 'ASSIGN')}>
              {ticket.assigned_to_user_id ? 'Reassign' : 'Assign'}
            </button>
          </>
        )}
        {canEdit && (
          <button className="btn" onClick={() => setDialog('EDIT')}>
            Edit
          </button>
        )}
        {!embedded && (
          <button className="btn" onClick={() => navigate('/service-desk/workspace?id=' + s(ticket.id))}>
            Open in workspace
          </button>
        )}
      </div>

      <div className="sd-detail-grid">
        <div className="sd-detail-main">
          <div className="tabs sd-tabs">
            {PANELS.map(([k, text]) => (
              <button
                key={k}
                className={k === panel ? 'tab active' : 'tab'}
                onClick={() => setPanel(k)}
              >
                {text}
                {k === 'escalations' && escalations.length > 0 ? ' (' + escalations.length + ')' : ''}
              </button>
            ))}
          </div>

          {panel === 'activity' && (
            <SecCard title="Activity timeline" sub="Every action on this ticket, newest last" pad>
              <ActivityFeed items={bundle?.activity ?? []} />
            </SecCard>
          )}

          {panel === 'conversation' && (
            <>
              <SecCard title="Conversation" sub="Public replies are visible to the requester; internal notes are not" pad>
                <CommentList comments={bundle?.comments ?? []} canSeeInternal={canInternal} />
                <Composer ticketId={ticket.id} surface={surface} canInternal={canInternal} onPosted={refresh} />
              </SecCard>
              <SecCard title="Attachments" sub="Up to 10 MB per file" pad>
                <AttachmentsPanel
                  ticketId={ticket.id}
                  surface={surface}
                  items={bundle?.attachments ?? []}
                  onChanged={refresh}
                />
              </SecCard>
            </>
          )}

          {panel === 'details' && (
            <SecCard title="Ticket detail" pad>
              <dl className="sd-auto">
                <Row k="Ticket number"><span className="td-cell-mono">{ticketRef(ticket)}</span></Row>
                <Row k="Type">{label(ticket.ticket_type)}</Row>
                <Row k="Status"><StatusChip value={ticket.status} /></Row>
                <Row k="Priority"><PriorityChip value={ticket.priority} /></Row>
                <Row k="Impact">{label(ticket.impact)}</Row>
                <Row k="Urgency">{label(ticket.urgency)}</Row>
                <Row k="Category">{dash(ticket.category_name)}</Row>
                <Row k="Subcategory">{dash(ticket.subcategory_name)}</Row>
                <Row k="Source">{label(ticket.source)}</Row>
                <Row k="Classification">{label(ticket.data_classification)}</Row>
                <Row k="Department">{dash(ticket.department_name ?? ticket.requester_department_id)}</Row>
                <Row k="Preferred contact">{label(ticket.preferred_contact)}</Row>
                <Row k="Opened">{fmtDT(ticket.opened_at ?? ticket.created_at)}</Row>
                <Row k="First response">{fmtDT(ticket.first_response_at)}</Row>
                <Row k="Resolved">{fmtDT(ticket.resolved_at)}</Row>
                <Row k="Closed">{fmtDT(ticket.closed_at)}</Row>
                <Row k="Time to resolve">{fmtDur(ticket.resolution_minutes ?? ticket.resolution_time_minutes)}</Row>
                <Row k="Satisfaction">
                  {num(ticket.satisfaction_rating) > 0 ? num(ticket.satisfaction_rating) + ' / 5' : 'Not rated'}
                </Row>
                <Row k="Tags"><TagList tags={ticket.tags} /></Row>
              </dl>
              <div className="sd-panel-title muted">Description</div>
              <p className="sd-desc">{s(ticket.description) || 'No description provided.'}</p>
              {s(ticket.resolution_summary) ? (
                <>
                  <div className="sd-panel-title muted">Resolution</div>
                  <p className="sd-desc">{s(ticket.resolution_summary)}</p>
                </>
              ) : null}
            </SecCard>
          )}

          {panel === 'asset' && (
            <SecCard
              title="Affected asset"
              sub="Linked from the HOPE DESIGN Asset Register"
              pad
              actions={
                asset ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate('/service-desk/scan?code=' + s(asset.asset_no))}
                  >
                    Scan history
                  </button>
                ) : undefined
              }
            >
              {!asset ? (
                <p className="muted" style={{ margin: 0 }}>
                  This ticket is not linked to an asset.
                </p>
              ) : (
                <>
                  <div className="sd-asset-picked">
                    <b className="td-cell-mono">{dash(asset.asset_no)}</b>
                    <span>{dash(asset.name)}</span>
                    <span className="chip">{label(asset.status)}</span>
                  </div>
                  <dl className="sd-auto">
                    <Row k="Category">{dash(asset.category_name)}</Row>
                    <Row k="Manufacturer">{dash(asset.manufacturer)}</Row>
                    <Row k="Model">{dash(asset.model)}</Row>
                    <Row k="Serial">{dash(asset.serial_no)}</Row>
                    <Row k="Condition">{label(asset.condition)}</Row>
                    <Row k="Operational state">{label(asset.operational_state)}</Row>
                    <Row k="Last maintenance">{fmtDT(asset.last_maintenance)}</Row>
                    <Row k="Next maintenance">{fmtDT(asset.next_maintenance)}</Row>
                    <Row k="Last scanned">{fmtAgo(asset.last_scan_at)}</Row>
                  </dl>
                </>
              )}
            </SecCard>
          )}

          {panel === 'related' && (
            <SecCard
              title="Related tickets"
              sub="Duplicates, blockers and parent incidents"
              pad
            >
              <RelationsPanel
                ticketId={ticket.id}
                related={related}
                relationTypes={meta.meta?.relationTypes ?? ['RELATED']}
                canEdit={agent}
                onChanged={refresh}
              />
            </SecCard>
          )}

          {panel === 'knowledge' && (
            <SecCard title="Knowledge" sub="Articles linked to this ticket, plus suggested reading">
              <div className="card-pad">
                <KnowledgeLinks
                  ticketId={ticket.id}
                  linked={knowledge}
                  canEdit={agent}
                  onChanged={refresh}
                />
              </div>
            </SecCard>
          )}

          {panel === 'escalations' && (
            <SecCard title="Escalations" sub="Automatic and manual escalation history" pad>
              {escalations.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  This ticket has never been escalated.
                </p>
              ) : (
                <ul className="sd-rel">
                  {escalations.map((e) => (
                    <li key={s(e.id)}>
                      <span className="chip">Level {num(e.level)}</span>
                      <b>{dash(e.level_name ?? e.level_code)}</b>
                      <span className="sd-rel-subj">{dash(e.reason)}</span>
                      <span className="muted">{fmtAgo(e.created_at)}</span>
                      <span className="chip">{label(e.status ?? e.state)}</span>
                      {agent && !e.acknowledged_at && (
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            void sdPost(
                              base + '/escalations/' + s(e.id) + '/acknowledge',
                              {}
                            ).then(refresh).catch((err) => setError(sdErr(err)));
                          }}
                        >
                          Acknowledge
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </SecCard>
          )}

          {error && <ErrorBanner error={error} />}
        </div>

        <aside className="sd-detail-side">
          <SecCard title="Service level" sub={open ? 'Timers are running' : 'Timers stopped'} pad>
            <SlaMeter sla={bundle?.sla ?? null} />
          </SecCard>
          <SecCard title="Queue and ownership" pad>
            <dl className="sd-auto">
              <Row k="Queue">{dash(ticket.queue_name)}</Row>
              <Row k="Queue code"><span className="td-cell-mono">{dash(ticket.queue_code)}</span></Row>
              <Row k="Strategy">{label(ticket.assignment_strategy)}</Row>
              <Row k="Technician">{dash(ticket.assignee_name)}</Row>
              <Row k="Escalation level">{levels ? 'Level ' + levels : 'None'}</Row>
              <Row k="Replies">{num(ticket.reply_count)} public / {num(ticket.note_count)} internal</Row>
            </dl>
          </SecCard>
          {(!embedded || asset) && (
            <SecCard title="Affected asset" pad>
              {!asset ? (
                <p className="muted" style={{ margin: 0 }}>
                  No asset linked.
                </p>
              ) : (
                <div className="sd-acard">
                  <b className="td-cell-mono">{dash(asset.asset_no)}</b>
                  <span className="sd-acard-sum">{dash(asset.name)}</span>
                  <span className="muted">{dash(asset.category_name)}</span>
                  <span className="chip">{label(asset.status)}</span>
                </div>
              )}
            </SecCard>
          )}
        </aside>
      </div>
    </div>
  );

  const shell = embedded ? (
    detail
  ) : (
    <div className="page" style={modStyle()}>
      <SdHead
        title={ticketRef(ticket)}
        sub={subjectOf(ticket)}
        actions={
          <>
            <button className="btn" onClick={refresh} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh'}
            </button>
            <button className="btn" onClick={() => navigate('/service-desk/tickets')}>
              Back to list
            </button>
          </>
        }
      />
      <SdTabs active="tickets" />
      {detail}
    </div>
  );

  return (
    <>
      {shell}
      {dialog === 'ASSIGN' && (
        <AssignDialog
          ticket={ticket}
          strategies={meta.meta?.assignmentStrategies ?? ['MANUAL']}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'REASSIGN' && (
        <AssignDialog
          ticket={ticket}
          strategies={meta.meta?.assignmentStrategies ?? ['MANUAL']}
          reassign
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'EDIT' && (
        <EditTicketDialog
          ticket={ticket}
          priorities={meta.meta?.priorities ?? ['P1', 'P2', 'P3', 'P4']}
          impacts={meta.meta?.impacts ?? ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR']}
          urgencies={meta.meta?.urgencies ?? ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']}
          canOverride={canAssign}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'PENDING' && (
        <PendingDialog ticketId={ticket.id} onClose={() => setDialog(null)} onDone={() => {
          setDialog(null);
          refresh();
        }} />
      )}
      {dialog === 'RESOLVE' && (
        <ResolveDialog
          ticketId={ticket.id}
          codes={meta.meta?.resolutionCodes ?? ['FIXED']}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'ESCALATE' && (
        <EscalateDialog
          ticketId={ticket.id}
          currentLevel={ticket.escalation_level}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'CONFIRM' && (
        <ConfirmResolutionDialog
          base={base}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'CLOSE' && (
        <SimpleNoteDialog
          title={'Close ' + ticketRef(ticket)}
          confirm="Close ticket"
          labelText="Closing note"
          hint="Optional. The requester is notified that the ticket is closed."
          onSubmit={async (note) => {
            await runAction('CLOSE', note ? { reason: note } : {});
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'REOPEN' && (
        <SimpleNoteDialog
          title={'Reopen ' + ticketRef(ticket)}
          confirm="Reopen ticket"
          labelText="Reason for reopening"
          hint="Required. Recorded in the audit trail."
          onSubmit={async (note) => {
            if (!note) throw new Error('A reason is required to reopen a ticket.');
            await runAction('REOPEN', { reason: note });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'CANCEL' && (
        <SimpleNoteDialog
          title={'Cancel ' + ticketRef(ticket)}
          confirm="Cancel ticket"
          labelText="Reason for cancelling"
          hint="Required. Recorded in the audit trail."
          onSubmit={async (note) => {
            if (!note) throw new Error('A reason is required to cancel a ticket.');
            await runAction('CANCEL', { reason: note });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
