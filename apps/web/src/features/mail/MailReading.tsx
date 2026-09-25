/**
 * Company mail - single message.
 *
 * Delivery state is rendered from what the provider actually confirmed. A message the
 * provider merely accepted reads "Sent", not "Delivered", because the backend has not
 * confirmed delivery. Classification, forwarding, download and export restrictions come
 * from the backend policy object; a restriction is shown as the reason the action is
 * unavailable, never as a hidden button.
 */
import { useState } from 'react';
import { navigate } from '../../router';
import { ErrorBanner, PageLoader, Pager } from '../../components/ui';
import { toast } from '../../components/toast';
import {
  archiveMessage,
  applyLabel,
  createDraft,
  deleteAttachment,
  deleteMessage,
  downloadAttachment,
  moveMessage,
  patchMessage,
  purgeMessage,
  removeLabel,
  restoreMessage,
  submitApproval,
  unarchiveMessage,
  uploadAttachment,
  attachErpDocument,
} from './mailApi';
import { useMailMessage } from './useMail';
import {
  EmptyRow,
  MailHead,
  MailTabs,
  Nothing,
  RefreshBtn,
  SecCard,
  countText,
  modStyle,
  moneyText,
  s,
  sizeText,
  truncate,
  whenText,
} from './mailShared';
import { BlockedNote, ToneBadge } from './mailBits';
import {
  POLICY_LABELS,
  attachmentDownloadBlocked,
  classificationTone,
  deliveryView,
  policyAllows,
  policyBlocked,
  policyReason,
} from './mailDelivery';
import type { MessageAttachment, MessageRecipient } from './mail.types';

const FOLDER_TAB: Record<string, string> = {
  INBOX: 'inbox',
  DRAFTS: 'drafts',
  SENT: 'sent',
  SCHEDULED: 'scheduled',
  ARCHIVE: 'archive',
  SPAM: 'spam',
  TRASH: 'trash',
  OUTBOX: 'outbox',
};

function recipientList(rows: MessageRecipient[] | undefined, kind: string): MessageRecipient[] {
  return (rows ?? []).filter((r) => String(r.kind).toUpperCase() === kind);
}

function addressText(rows: MessageRecipient[]): string {
  return rows.map((r) => (r.name ? r.name + ' <' + r.email + '>' : r.email)).join(', ');
}

export default function MailReading({ id }: { id: number }) {
  const detail = useMailMessage(id);
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState<string>('');

  const body = detail.data;
  const m = body?.message;
  const policy = body?.policy;
  const confirmed = body?.confirmedDeliveryStatus ?? null;
  const events = body?.deliveryEvents ?? [];
  const attachments = body?.attachments ?? [];
  const recipients = body?.recipients ?? [];
  const labels = body?.labels ?? [];
  const approvals = body?.approvals ?? [];

  function fail(e: unknown) {
    toast.fromError('The mail operation could not be completed', e);
  }

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(label);
    setNotice('');
    try {
      await fn();
      setNotice(done);
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function reply(mode: 'reply' | 'replyAll' | 'forward') {
    if (!m) return;
    setBusy(mode);
    try {
      const from = recipientList(recipients, 'FROM');
      const to =
        mode === 'forward'
          ? []
          : recipientList(recipients, 'TO')
              .filter((r) => r.email && r.email !== m.fromEmail)
              .map((r) => r.email);
      const cc = mode === 'replyAll' ? recipientList(recipients, 'CC').map((r) => r.email) : [];
      const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
      const subject = m.subject && m.subject.toLowerCase().startsWith(prefix.trim().toLowerCase())
        ? m.subject
        : prefix + (m.subject ?? '');
      const quoted =
        '\n\n--- ' + (mode === 'forward' ? 'Forwarded message' : 'Original message') + ' ---\n' +
        'From: ' + (m.fromName || m.fromEmail || '') + '\n' +
        'Date: ' + whenText(m.sentAt ?? m.createdAt) + '\n' +
        'Subject: ' + (m.subject ?? '') + '\n\n' +
        truncate(body?.message?.subject ?? '', 0);
      const quotedBody = '\n\n--- ' + (mode === 'forward' ? 'Forwarded message' : 'Original message') + ' ---\n' +
        'From: ' + (m.fromName || m.fromEmail || '') + '\n' +
        'Date: ' + whenText(m.sentAt ?? m.createdAt) + '\n' +
        'Subject: ' + (m.subject ?? '') + '\n';
      const created = await createDraft({
        subject,
        body: quotedBody + quoted,
        to,
        cc,
        replyTo: m.id,
        mailboxId: m.mailboxId,
        entityType: m.entityType ?? undefined,
        entityId: m.entityId ?? undefined,
        classification: m.classification,
      });
      const newId = Number((created as Record<string, unknown>).id ?? 0);
      void from;
      if (newId > 0) navigate('/communication/mail/compose/' + newId);
      else {
        setNotice('Draft created. Open Drafts to continue.');
        detail.refresh();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function download(a: MessageAttachment) {
    const blocked = attachmentDownloadBlocked(policy, { scanStatus: a.scanStatus });
    if (blocked) {
      toast.warning(blocked);
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

  async function upload(file: File) {
    if (!m) return;
    setBusy('upload');
    try {
      await uploadAttachment(m.id, file);
      setNotice('Attachment uploaded. Files are stored but not malware-scanned in this deployment.');
      detail.refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  if (detail.loading && !body) {
    return (
      <div className="page" style={modStyle()}>
        <PageLoader label="Loading message..." />
      </div>
    );
  }

  if (detail.error) {
    return (
      <div className="page" style={modStyle()}>
        <MailHead kicker="Company mail" title="Message unavailable" />
        <ErrorBanner error={detail.error} />
        <div className="card card-pad">
          <button type="button" className="btn" onClick={() => navigate('/communication/mail')}>
            Back to inbox
          </button>
        </div>
      </div>
    );
  }

  if (!m) {
    return (
      <div className="page" style={modStyle()}>
        <MailHead kicker="Company mail" title="Message not found" />
        <Nothing text="This message is not available or you do not have access to it." action="Back to inbox" onAction={() => navigate('/communication/mail')} />
      </div>
    );
  }

  const dv = deliveryView(m.status, confirmed, events);
  const forwardReason = policyReason(policy, 'forward');
  const toRows = recipientList(recipients, 'TO');
  const ccRows = recipientList(recipients, 'CC');
  const bccRows = recipientList(recipients, 'BCC');
  const blocked = policyBlocked(policy);

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker={'Company mail \u00b7 ' + (s(m.mailboxAddress) || 'mailbox')}
        title={m.subject || '(no subject)'}
        sub={'From ' + (m.fromName || m.fromEmail || 'unknown sender') + ' \u00b7 ' + whenText(m.sentAt ?? m.createdAt)}
        actions={
          <div className="head-actions">
            <RefreshBtn onClick={detail.refresh} disabled={detail.loading} />
            <button type="button" className="btn" onClick={() => navigate('/communication/mail')}>
              Back to list
            </button>
          </div>
        }
      />
      <MailTabs active={FOLDER_TAB[String(m.folder).toUpperCase()] ?? 'inbox'} />

      <div className="filter-bar">
        {forwardReason ? (
          <button type="button" className="btn btn-sm" disabled title={forwardReason}>
            Reply
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void reply('reply')}>
              Reply
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void reply('replyAll')}>
              Reply all
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void reply('forward')}>
              Forward
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== ''}
          onClick={() => void run('star', () => patchMessage(m.id, { isStarred: !m.isStarred }), m.isStarred ? 'Star removed' : 'Message starred')}
        >
          {m.isStarred ? 'Unstar' : 'Star'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== ''}
          onClick={() => void run('important', () => patchMessage(m.id, { isImportant: !m.isImportant }), m.isImportant ? 'No longer important' : 'Marked important')}
        >
          {m.isImportant ? 'Not important' : 'Mark important'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== ''}
          onClick={() => void run('read', () => patchMessage(m.id, { isRead: !m.isRead }), m.isRead ? 'Marked unread' : 'Marked read')}
        >
          {m.isRead ? 'Mark unread' : 'Mark read'}
        </button>
        {String(m.folder).toUpperCase() === 'ARCHIVE' ? (
          <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void run('archive', () => unarchiveMessage(m.id), 'Returned to the inbox')}>
            Unarchive
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void run('archive', () => archiveMessage(m.id), 'Message archived')}>
            Archive
          </button>
        )}
        {String(m.folder).toUpperCase() === 'TRASH' ? (
          <>
            <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => void run('restore', () => restoreMessage(m.id), 'Message restored')}>
              Restore
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy !== ''}
              onClick={() => {
                if (!window.confirm('Permanently purge this message and its attachments? This cannot be undone.')) return;
                void run('purge', () => purgeMessage(m.id), 'Message purged');
              }}
            >
              Delete permanently
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy !== ''}
            onClick={() => {
              if (!window.confirm('Move this message to Trash? It can be restored later.')) return;
              void run('trash', () => deleteMessage(m.id), 'Message moved to Trash');
            }}
          >
            Delete
          </button>
        )}
      </div>

      {notice ? <p className="card-pad cell-sub">{notice}</p> : null}

      {blocked.length > 0 ? (
        <div className="card card-pad">
          <h3>Restrictions on this message</h3>
          <ul className="cell-sub">
            {blocked.map((b) => (
              <li key={b.action}>
                {POLICY_LABELS[b.action] ?? b.action}: {b.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="com-msg-layout">
        <div>
          <SecCard title="Message" pad>
            <p>
              <ToneBadge tone={dv.tone} label={dv.label} title={dv.detail} />{' '}
              <ToneBadge tone={classificationTone(m.classification)} label={s(m.classification) || 'Unclassified'} />
            </p>
            <div className="cell-sub">{dv.detail}</div>
            <div className="whitespace-pre">{s(body?.message?.snippet) ? '' : ''}</div>
            <dl className="com-context">
              <div>
                <dt>From</dt>
                <dd>{s(m.fromName) || s(m.fromEmail) || '\u2014'}</dd>
              </div>
              <div>
                <dt>To</dt>
                <dd>{addressText(toRows) || '\u2014'}</dd>
              </div>
              {ccRows.length > 0 ? (
                <div>
                  <dt>Cc</dt>
                  <dd>{addressText(ccRows)}</dd>
                </div>
              ) : null}
              {bccRows.length > 0 ? (
                <div>
                  <dt>Bcc</dt>
                  <dd>{addressText(bccRows)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Mailbox</dt>
                <dd>{s(m.mailboxAddress) || '\u2014'}</dd>
              </div>
              <div>
                <dt>On behalf of</dt>
                <dd>{s(m.onBehalfOf) || '\u2014'}</dd>
              </div>
              {m.entityType && m.entityId ? (
                <div>
                  <dt>Linked record</dt>
                  <dd>
                    {s(m.entityType)} #{countText(m.entityId)}
                  </dd>
                </div>
              ) : null}
            </dl>
          </SecCard>

          <SecCard title="Delivery" pad>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Provider confirmed</th>
                    <th scope="col">When</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 ? (
                    <EmptyRow cols={4}>
                      <Nothing text="The mail provider has not reported any delivery events for this message yet." />
                    </EmptyRow>
                  ) : (
                    events.map((e) => (
                      <tr key={e.id}>
                        <td className="cell-main">{s(e.eventType)}</td>
                        <td>{e.confirmedByProvider ? 'Yes' : 'No (inferred)'}</td>
                        <td>{whenText(e.occurredAt)}</td>
                        <td className="cell-sub">{s(e.detail) || '\u2014'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SecCard>

          <SecCard title="Attachments" sub={countText(attachments.length) + ' file(s)'} pad>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Source</th>
                    <th scope="col">Size</th>
                    <th scope="col">Scan</th>
                    <th scope="col">Added</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {attachments.length === 0 ? (
                    <EmptyRow cols={6}>
                      <Nothing text="No attachments on this message." />
                    </EmptyRow>
                  ) : (
                    attachments.map((a) => {
                      const blockReason = attachmentDownloadBlocked(policy, { scanStatus: a.scanStatus });
                      return (
                        <tr key={a.id}>
                          <td>
                            <div className="cell-main">{s(a.fileName)}</div>
                            <div className="cell-sub">{s(a.fileType)}</div>
                          </td>
                          <td className="cell-sub">{s(a.source) || 'UPLOAD'}</td>
                          <td>{sizeText(a.fileSize)}</td>
                          <td>
                            <div className="cell-main">{s(a.scanStatus) || 'NOT_SCANNED'}</div>
                            {blockReason ? <BlockedNote>{blockReason}</BlockedNote> : null}
                          </td>
                          <td>{whenText(a.createdAt)}</td>
                          <td>
                            <div className="row-actions">
                              <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                disabled={busy !== '' || !!blockReason}
                                title={blockReason || undefined}
                                onClick={() => void download(a)}
                              >
                                {busy === 'dl-' + a.id ? 'Downloading...' : 'Download'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                disabled={busy !== ''}
                                onClick={() => {
                                  if (!window.confirm('Remove attachment "' + a.fileName + '" from this message?')) return;
                                  void run('adel', () => deleteAttachment(a.id), 'Attachment removed');
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="filter-row">
              <label className="stack-row">
                <span>Upload a file (20 MB maximum)</span>
                <input
                  type="file"
                  disabled={busy !== '' || !policyAllows(policy, 'download')}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) void upload(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="stack-row">
                <span>Attach an ERP document</span>
                <input
                  className="hk-input"
                  type="number"
                  min={1}
                  placeholder="DMS document id"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const v = Number((e.target as HTMLInputElement).value);
                    if (!v) return;
                    void run('erp', () => attachErpDocument(m.id, { documentId: v, entityType: m.entityType ?? null, entityId: m.entityId ?? null }), 'ERP document attached');
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
                <span className="cell-sub">Type the document id and press Enter. The document must exist and be at least as classified as this message.</span>
              </label>
            </div>
          </SecCard>

          <SecCard title="Approvals" sub={countText(approvals.length) + ' step(s)'} pad>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Level</th>
                    <th scope="col">Approver role</th>
                    <th scope="col">Approver</th>
                    <th scope="col">State</th>
                    <th scope="col">Requested</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {approvals.length === 0 ? (
                    <EmptyRow cols={6}>
                      <Nothing text="No approval was requested for this message." />
                    </EmptyRow>
                  ) : (
                    approvals.map((a) => (
                      <tr key={a.id}>
                        <td>{countText(a.requiredLevel)}</td>
                        <td className="cell-sub">{s(a.approverRole) || '\u2014'}</td>
                        <td className="cell-sub">{s(a.approverName) || '\u2014'}</td>
                        <td className="cell-main">{s(a.status)}</td>
                        <td>{whenText(a.requestedAt)}</td>
                        <td className="cell-sub">{s(a.decisionNote) || '\u2014'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="filter-row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== ''}
                onClick={() =>
                  void run(
                    'reqappr',
                    () => submitApproval(m.id, { reason: 'Requested from the message view' }),
                    'Approval requested',
                  )
                }
              >
                Request approval
              </button>
              <span className="cell-sub">Composing an approved message is normally done from the composer, which names the approver and the role being satisfied.</span>
            </div>
          </SecCard>

          <SecCard title="Thread" pad>
            {body?.thread ? (
              <div className="cell-sub">
                Conversation {countText(body.thread.id)} with {countText(body.thread.messageCount)} message(s).
              </div>
            ) : (
              <p className="cell-sub">This message is not part of a conversation thread.</p>
            )}
          </SecCard>
        </div>

        <aside>
          <SecCard title="Your access" pad>
            <ul className="cell-sub">
              <li>View: {body?.mailboxPermissions?.canView ? 'allowed' : 'not granted'}</li>
              <li>Send: {body?.mailboxPermissions?.canSend ? 'allowed' : 'not granted'}</li>
              <li>Reply: {body?.mailboxPermissions?.canReply ? 'allowed' : 'not granted'}</li>
              <li>Delete: {body?.mailboxPermissions?.canDelete ? 'allowed' : 'not granted'}</li>
              <li>Archive: {body?.mailboxPermissions?.canArchive ? 'allowed' : 'not granted'}</li>
              <li>Export: {body?.mailboxPermissions?.canExport ? 'allowed' : 'not granted'}</li>
            </ul>
            {policy ? (
              <div className="cell-sub">
                This message is classified {s(body?.classification?.label) || s(m.classification)}.
              </div>
            ) : null}
          </SecCard>

          <SecCard title="Labels" pad>
            {labels.length === 0 ? (
              <p className="cell-sub">No labels applied.</p>
            ) : (
              <ul className="cell-sub">
                {labels.map((l) => (
                  <li key={l.id}>
                    {l.name}{' '}
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      disabled={busy !== ''}
                      onClick={() => void run('unlabel', () => removeLabel(m.id, l.id), 'Label removed')}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="stack-row">
              <span>Apply a label by id</span>
              <input
                className="hk-input"
                type="number"
                min={1}
                placeholder="Label id"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = Number((e.target as HTMLInputElement).value);
                  if (!v) return;
                  void run('label', () => applyLabel(m.id, v), 'Label applied');
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            </label>
          </SecCard>

          <SecCard title="Move" pad>
            <label className="stack-row">
              <span>Folder</span>
              <select
                className="hk-select"
                defaultValue=""
                disabled={busy !== ''}
                onChange={(e) => {
                  const f = e.target.value;
                  if (!f) return;
                  void run('move', () => moveMessage(m.id, { folder: f }), 'Message moved to ' + f);
                  e.target.value = '';
                }}
              >
                <option value="">Choose a folder...</option>
                <option value="INBOX">Inbox</option>
                <option value="ARCHIVE">Archive</option>
                <option value="SPAM">Spam</option>
                <option value="TRASH">Trash</option>
              </select>
            </label>
          </SecCard>

          <SecCard title="Audit trail" sub={countText((body?.audit ?? []).length) + ' entries'} pad>
            <ul className="cell-sub">
              {(body?.audit ?? []).slice(0, 40).map((a, idx) => (
                <li key={String(a.id ?? idx)}>
                  {s(a.action)} {'\u00b7'} {whenText(a.createdAt)}
                </li>
              ))}
            </ul>
          </SecCard>

          <SecCard title="Record" pad>
            <dl className="com-context">
              <div>
                <dt>Message id</dt>
                <dd>{countText(m.id)}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{countText(m.version)}</dd>
              </div>
              <div>
                <dt>Provider id</dt>
                <dd>{s(m.providerMessageId) || '\u2014'}</dd>
              </div>
              <div>
                <dt>Size on record</dt>
                <dd>{moneyText(null)}</dd>
              </div>
            </dl>
          </SecCard>
        </aside>
      </div>

      <Pager page={1} pageSize={25} total={1} onPage={() => undefined} />
    </div>
  );
}
