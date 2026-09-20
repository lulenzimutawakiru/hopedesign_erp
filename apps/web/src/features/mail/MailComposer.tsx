/**
 * Company mail - composer.
 *
 * The composer never sends anything the backend has not been asked to persist
 * first: a new message is created as a DRAFT, then sent from that row. That
 * ordering means a failed send always leaves a recoverable draft rather than
 * losing what the author typed.
 *
 * Send is gated twice - by the caller's `communication.emails.send` permission
 * and by the selected mailbox's own `canSend` grant - and the send result is
 * reported verbatim: a message the provider merely accepted reads "accepted",
 * never "delivered". Classification rules and the message policy are shown as
 * the reason an action is unavailable, never as a hidden control.
 */
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Notice, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import {
  attachErpDocument,
  createDraft,
  deleteAttachment,
  downloadAttachment,
  scheduleMessage,
  sendMessage,
  submitApproval,
  unscheduleMessage,
  updateDraft,
  uploadAttachment,
} from './mailApi';
import {
  useMailClassifications,
  useMailMessage,
  useMailSignatures,
  useMailboxes,
} from './useMail';
import {
  EmptyRow,
  MailHead,
  MailTabs,
  Nothing,
  RefreshBtn,
  SecCard,
  countText,
  modStyle,
  num,
  s,
  sizeText,
  whenText,
} from './mailShared';
import { ToneBadge } from './mailBits';
import { attachmentDownloadBlocked, deliveryView, policyBlocked } from './mailDelivery';
import type { MessageAttachment } from './mail.types';

const PRIORITY_OPTIONS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const IMMUTABLE = ['SENT', 'QUEUED', 'SENDING'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO timestamp -> the local `YYYY-MM-DDTHH:mm` a datetime-local input wants. */
function toLocalInput(iso: unknown): string {
  const raw = s(iso);
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

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function MailComposer({ draftId }: { draftId: number | null }) {
  const { user } = useAuth();
  const [createdId, setCreatedId] = useState<number | null>(null);
  const id = draftId && draftId > 0 ? draftId : createdId;

  const detail = useMailMessage(id);
  const mailboxes = useMailboxes();
  const classes = useMailClassifications();
  const signatures = useMailSignatures();

  const [version, setVersion] = useState<number>(0);
  const [mailboxId, setMailboxId] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [cc, setCc] = useState<string>('');
  const [bcc, setBcc] = useState<string>('');
  const [showBcc, setShowBcc] = useState<boolean>(false);
  const [subject, setSubject] = useState<string>('');
  const [bodyText, setBodyText] = useState<string>('');
  const [priority, setPriority] = useState<string>('NORMAL');
  const [classification, setClassification] = useState<string>('');
  const [signatureId, setSignatureId] = useState<string>('');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [approvalReason, setApprovalReason] = useState<string>('');
  const [erpDocId, setErpDocId] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState<string>('');

  const hydrated = useRef(false);

  // Load the stored draft into the form exactly once, so a background refresh
  // can never overwrite what the author is typing.
  useEffect(() => {
    const data = detail.data;
    if (!data || hydrated.current) return;
    hydrated.current = true;
    const m = data.message;
    const rows = data.recipients ?? [];
    const of = (kind: string) =>
      rows
        .filter((r) => String(r.kind).toUpperCase() === kind)
        .map((r) => r.email)
        .join(', ');
    setSubject(s(m.subject));
    setBodyText(s(m.body));
    setPriority(s(m.priority) || 'NORMAL');
    setClassification(s(m.classification));
    setMailboxId(m.mailboxId ? String(m.mailboxId) : '');
    setSignatureId(m.signatureId ? String(m.signatureId) : '');
    setScheduledAt(toLocalInput(m.scheduledAt));
    setVersion(num(m.version));
    setTo(of('TO'));
    setCc(of('CC'));
    setBcc(of('BCC'));
    if (of('BCC')) setShowBcc(true);
  }, [detail.data]);

  // A brand new draft that gets created mid-session reports its version back so
  // the next save is checked against the row it actually wrote.
  useEffect(() => {
    const data = detail.data;
    if (!data || !hydrated.current) return;
    const v = num(data.message.version);
    if (v > 0) setVersion(v);
  }, [detail.data]);

  const mb = (mailboxes.data ?? []).find((x) => String(x.id) === mailboxId) ?? null;
  const maySend = can(user, 'communication.emails.send');
  const canSend = mb ? mb.permissions.canSend : maySend;
  const canDraft = can(user, 'communication.mail_drafts.create');

  const message = detail.data?.message;
  const status = s(message?.status).toUpperCase();
  const immutable = IMMUTABLE.includes(status);
  const policy = detail.data?.policy;
  const blocked = policyBlocked(policy);
  const klass = detail.data?.classification ?? null;
  const attachments = detail.data?.attachments ?? [];
  const dv = deliveryView(status || 'DRAFT', detail.data?.confirmedDeliveryStatus ?? null, detail.data?.deliveryEvents ?? []);

  function fail(e: unknown) {
    toast.fromError('The mail operation could not be completed', e);
  }

  function payload(): Record<string, unknown> {
    return {
      mailboxId: mailboxId ? num(mailboxId) : undefined,
      to: to.trim(),
      cc: cc.trim(),
      bcc: bcc.trim(),
      subject,
      body: bodyText,
      classification: classification || undefined,
      priority,
      signatureId: signatureId ? num(signatureId) : null,
    };
  }

  /**
   * Persist the form and return the draft id to act on. An existing draft is
   * patched under its optimistic-concurrency version; a new one is created and
   * the URL is rewritten (replace, so Back does not re-open the blank form).
   */
  async function ensureDraft(): Promise<number | null> {
    if (id && id > 0) {
      const res = await updateDraft(id, { ...payload(), expectedVersion: version > 0 ? version : undefined });
      setVersion(num((res as Record<string, unknown>).version) || version);
      return id;
    }
    const res = (await createDraft(payload())) as Record<string, unknown>;
    const newId = num(res.id);
    if (newId > 0) {
      setCreatedId(newId);
      setVersion(num(res.version));
      hydrated.current = true;
      navigate('/communication/mail/compose/' + newId, { replace: true });
    }
    return newId > 0 ? newId : null;
  }

  async function saveDraft() {
    setBusy('save');
    setNotice('');
    try {
      const saved = await ensureDraft();
      if (saved) {
        setNotice('Draft saved.');
        detail.refresh();
      } else {
        toast.error('The draft could not be saved.');
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function send() {
    if (!canSend) {
      toast.warning('You do not have permission to send from this mailbox.');
      return;
    }
    setBusy('send');
    setNotice('');
    try {
      const target = await ensureDraft();
      if (!target) {
        toast.error('The draft could not be saved, so nothing was sent.');
        return;
      }
      const outcome = await sendMessage(target, {
        mailboxId: mailboxId ? num(mailboxId) : undefined,
        to: to.trim(),
        cc: cc.trim(),
        bcc: bcc.trim(),
      });
      const kind = outcome?.outcome;
      if (kind === 'SENT') {
        toast.success('Message accepted by the mail provider.');
        navigate('/communication/mail/sent');
      } else if (kind === 'SCHEDULED') {
        toast.success('Message scheduled.');
        navigate('/communication/mail/scheduled');
      } else if (kind === 'PENDING_APPROVAL') {
        toast.info('Message submitted for approval.');
        navigate('/communication/mail/approvals');
      } else {
        toast.error(outcome?.error || 'The message could not be sent.');
        detail.refresh();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function schedule() {
    const when = fromLocalInput(scheduledAt);
    if (!when) {
      toast.warning('Choose the date and time to send this message.');
      return;
    }
    setBusy('schedule');
    setNotice('');
    try {
      const target = await ensureDraft();
      if (!target) {
        toast.error('The draft could not be saved, so nothing was scheduled.');
        return;
      }
      await scheduleMessage(target, { scheduledAt: when });
      setNotice('Message scheduled.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function unschedule() {
    if (!id) return;
    setBusy('unschedule');
    setNotice('');
    try {
      await unscheduleMessage(id);
      setScheduledAt('');
      setNotice('Schedule cancelled. The message is back in drafts.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function requestApproval() {
    setBusy('approval');
    setNotice('');
    try {
      const target = await ensureDraft();
      if (!target) {
        toast.error('The draft could not be saved, so no approval was requested.');
        return;
      }
      await submitApproval(target, { reason: approvalReason.trim() || undefined });
      setApprovalReason('');
      setNotice('Submitted for approval.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function upload(file: File) {
    if (!id) return;
    setBusy('upload');
    try {
      await uploadAttachment(id, file);
      setNotice('Attachment uploaded. Files are stored but not malware-scanned in this deployment.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function attachErp() {
    const documentId = num(erpDocId);
    if (!id || documentId <= 0) {
      toast.warning('Enter the ERP document id to attach.');
      return;
    }
    setBusy('erp');
    try {
      await attachErpDocument(id, { documentId });
      setErpDocId('');
      setNotice('Document linked to this message.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function download(a: MessageAttachment) {
    const reason = attachmentDownloadBlocked(policy, { scanStatus: a.scanStatus });
    if (reason) {
      toast.warning(reason);
      return;
    }
    setBusy('dl-' + a.id);
    try {
      await downloadAttachment(a.id, a.fileName);
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function removeAttachment(a: MessageAttachment) {
    if (!window.confirm('Remove "' + a.fileName + '" from this message?')) return;
    setBusy('rm-' + a.id);
    try {
      await deleteAttachment(a.id);
      setNotice('Attachment removed.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  if (detail.loading && !detail.data) {
    return (
      <div className="page" style={modStyle()}>
        <PageLoader label="Loading draft..." />
      </div>
    );
  }

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title={id ? 'Edit draft' : 'New message'}
        sub={
          id
            ? 'Editing message #' + String(id) + '. Saving keeps it in Drafts until it is sent.'
            : 'A draft is created the first time you save, send, schedule or request approval.'
        }
        actions={
          <div className="head-actions">
            <RefreshBtn onClick={detail.refresh} disabled={detail.loading || !id} />
            <button type="button" className="btn" onClick={() => navigate('/communication/mail/drafts')}>
              Back to drafts
            </button>
          </div>
        }
      />
      <MailTabs active="drafts" />

      {detail.error ? <ErrorBanner error={detail.error} /> : null}
      {notice ? <Notice>{notice}</Notice> : null}
      {immutable ? (
        <Notice>
          This message is {dv.label.toLowerCase()} and can no longer be edited. Reply or forward it instead.
        </Notice>
      ) : null}

      {blocked.length > 0 ? (
        <div className="card card-pad">
          <h3>Restrictions from the message policy</h3>
          <ul className="cell-sub" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {blocked.map((b) => (
              <li key={b.action}>{b.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <SecCard
        title="Message"
        pad
        actions={
          <ToneBadge tone={dv.tone} label={dv.label} title={dv.detail} />
        }
      >
        <div className="stack-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="field" style={{ flex: '1 1 260px' }}>
            <span>From mailbox</span>
            <select
              className="hk-select"
              value={mailboxId}
              disabled={immutable}
              onChange={(e) => setMailboxId(e.target.value)}
            >
              <option value="">Personal draft (no mailbox)</option>
              {(mailboxes.data ?? []).map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.address + ' - ' + m.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="field" style={{ flex: '1 1 180px' }}>
            <span>Classification</span>
            <select
              className="hk-select"
              value={classification}
              disabled={immutable}
              onChange={(e) => setClassification(e.target.value)}
            >
              <option value="">Mailbox default</option>
              {(classes.data ?? []).map((c) => (
                <option key={String(c.id)} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field" style={{ flex: '0 1 150px' }}>
            <span>Priority</span>
            <select
              className="hk-select"
              value={priority}
              disabled={immutable}
              onChange={(e) => setPriority(e.target.value)}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="field" style={{ flex: '1 1 220px' }}>
            <span>Signature</span>
            <select
              className="hk-select"
              value={signatureId}
              disabled={immutable}
              onChange={(e) => setSignatureId(e.target.value)}
            >
              <option value="">No signature</option>
              {(signatures.data?.signatures ?? []).map((sig) => (
                <option key={sig.id} value={String(sig.id)}>
                  {sig.name + (sig.isDefault ? ' (default)' : '')}
                </option>
              ))}
            </select>
          </label>
        </div>

        {mb ? (
          <p className="cell-sub" style={{ marginTop: 8 }}>
            {mb.displayName +
              ' <' +
              mb.address +
              '> - ' +
              (mb.permissions.canSend ? 'send allowed' : 'send not permitted for you') +
              (mb.allowExternalSend ? '' : ' - external recipients blocked by the mailbox') +
              (mb.requireApproval ? ' - approval required before sending' : '')}
          </p>
        ) : null}

        <label className="field" style={{ marginTop: 12 }}>
          <span>To</span>
          <input
            className="hk-input"
            type="text"
            placeholder="name@example.com, another@example.com"
            value={to}
            disabled={immutable}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>

        <div className="stack-row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>Cc</span>
            <input
              className="hk-input"
              type="text"
              value={cc}
              disabled={immutable}
              onChange={(e) => setCc(e.target.value)}
            />
          </label>
          {showBcc ? (
            <label className="field" style={{ flex: '1 1 320px' }}>
              <span>Bcc</span>
              <input
                className="hk-input"
                type="text"
                value={bcc}
                disabled={immutable}
                onChange={(e) => setBcc(e.target.value)}
              />
            </label>
          ) : (
            <div className="stack-row" style={{ alignItems: 'flex-end' }}>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowBcc(true)}>
                Add Bcc
              </button>
            </div>
          )}
        </div>

        <label className="field" style={{ marginTop: 12 }}>
          <span>Subject</span>
          <input
            className="hk-input"
            type="text"
            value={subject}
            disabled={immutable}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>

        <label className="field" style={{ marginTop: 12 }}>
          <span>Message</span>
          <textarea
            className="hk-input"
            rows={14}
            value={bodyText}
            disabled={immutable}
            onChange={(e) => setBodyText(e.target.value)}
          />
        </label>

        {klass ? (
          <p className="cell-sub" style={{ marginTop: 8 }}>
            {'Classification "' +
              klass.label +
              '": ' +
              (klass.allowForward ? 'forward allowed' : 'forward blocked') +
              ', ' +
              (klass.allowDownload ? 'download allowed' : 'download blocked') +
              ', ' +
              (klass.allowPrint ? 'print allowed' : 'print blocked') +
              ', ' +
              (klass.allowExport ? 'export allowed' : 'export blocked') +
              ', ' +
              (klass.allowExternal ? 'external delivery allowed' : 'external delivery blocked') +
              (klass.requireApproval ? ' - approval required' : '')}
          </p>
        ) : null}
      </SecCard>

      <SecCard title="Delivery" pad>
        <div className="filter-bar">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== '' || immutable || !canDraft}
            onClick={() => void saveDraft()}
          >
            {busy === 'save' ? 'Saving...' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== '' || immutable || !canSend}
            title={canSend ? undefined : 'You do not have permission to send from this mailbox'}
            onClick={() => void send()}
          >
            {busy === 'send' ? 'Sending...' : 'Send now'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== '' || immutable}
            onClick={() => void requestApproval()}
          >
            {busy === 'approval' ? 'Submitting...' : 'Request approval'}
          </button>
          {status === 'SCHEDULED' ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy !== ''}
              onClick={() => void unschedule()}
            >
              {busy === 'unschedule' ? 'Cancelling...' : 'Cancel schedule'}
            </button>
          ) : null}
        </div>

        <div className="stack-row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          <label className="field" style={{ flex: '0 1 240px' }}>
            <span>Send at</span>
            <input
              className="hk-input"
              type="datetime-local"
              value={scheduledAt}
              disabled={immutable}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </label>
          <div className="stack-row" style={{ alignItems: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== '' || immutable || !scheduledAt}
              onClick={() => void schedule()}
            >
              {busy === 'schedule' ? 'Scheduling...' : 'Schedule send'}
            </button>
          </div>
          <label className="field" style={{ flex: '1 1 260px' }}>
            <span>Approval note (optional)</span>
            <input
              className="hk-input"
              type="text"
              value={approvalReason}
              disabled={immutable}
              onChange={(e) => setApprovalReason(e.target.value)}
            />
          </label>
        </div>
      </SecCard>

      {id ? (
        <SecCard
          title="Attachments"
          sub="Files are stored with the message; a link to an ERP document keeps the two in step."
          actions={
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              {busy === 'upload' ? 'Uploading...' : 'Upload file'}
              <input
                type="file"
                style={{ display: 'none' }}
                disabled={busy !== ''}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
            </label>
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Source</th>
                  <th scope="col">Size</th>
                  <th scope="col">Scan</th>
                  <th scope="col">Added</th>
                  <th scope="col" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {attachments.length === 0 ? (
                  <EmptyRow cols={6}>
                    <Nothing text="No attachments on this message yet." />
                  </EmptyRow>
                ) : (
                  attachments.map((a) => {
                    const blockedReason = attachmentDownloadBlocked(policy, { scanStatus: a.scanStatus });
                    return (
                      <tr key={a.id}>
                        <td>
                          <div className="cell-main">{s(a.fileName)}</div>
                          <div className="cell-sub">{s(a.fileType)}</div>
                        </td>
                        <td>{s(a.source)}</td>
                        <td>{sizeText(a.fileSize)}</td>
                        <td>{s(a.scanStatus) || 'not scanned'}</td>
                        <td>{whenText(a.createdAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs btn-ghost"
                              disabled={busy !== '' || blockedReason !== ''}
                              title={blockedReason || undefined}
                              onClick={() => void download(a)}
                            >
                              Download
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-ghost"
                              disabled={busy !== ''}
                              onClick={() => void removeAttachment(a)}
                            >
                              Remove
                            </button>
                          </div>
                          {blockedReason ? <div className="cell-sub">{blockedReason}</div> : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="stack-row" style={{ gap: 12, marginTop: 12, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '0 1 200px' }}>
              <span>ERP document id</span>
              <input
                className="hk-input"
                type="number"
                min={1}
                value={erpDocId}
                onChange={(e) => setErpDocId(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== '' || !erpDocId}
              onClick={() => void attachErp()}
            >
              {busy === 'erp' ? 'Linking...' : 'Attach ERP document'}
            </button>
            <span className="cell-sub">
              {countText(attachments.length) + ' attachment(s); external delivery of links depends on the classification.'}
            </span>
          </div>
        </SecCard>
      ) : null}

      <div className="card card-pad">
        <p className="cell-sub">
          {status === 'PENDING_APPROVAL'
            ? 'This message is waiting on approval. Editing it returns it to drafts for the approver to see the new version.'
            : 'Sending hands the message to the mail provider. Delivery is reported only when the provider confirms it.'}
        </p>
      </div>
    </div>
  );
}
