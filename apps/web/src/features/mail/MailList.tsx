/**
 * Company mail - folder workspace.
 *
 * Everything here is server-side. `GET /api/ops/mail/messages` owns filtering, sorting
 * and paging; `GET /api/ops/mail/messages/summary` owns the folder totals. The screen
 * therefore never presents a page-local count as a mailbox-wide one, and never filters a
 * loaded page in the browser and calls it search.
 */
import { useEffect, useMemo, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, Pager } from '../../components/ui';
import { toast } from '../../components/toast';
import { archiveMessage, patchMessage, restoreMessage, unarchiveMessage } from './mailApi';
import {
  useDebounced,
  useMailClassifications,
  useMailMessages,
  useMailboxes,
  useMailSummary,
} from './useMail';
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
import { ToneBadge } from './mailBits';
import { classificationTone, deliveryView } from './mailDelivery';
import type { FolderKey, MessageListItem } from './mail.types';

interface FolderDef {
  key: FolderKey;
  tab: string;
  path: string;
  title: string;
  blurb: string;
}

const INBOX_DEF: FolderDef = {
  key: 'INBOX',
  tab: 'inbox',
  path: '/communication/mail',
  title: 'Inbox',
  blurb: 'Mail delivered to the mailboxes you can read.',
};
const DRAFTS_DEF: FolderDef = {
  key: 'DRAFTS',
  tab: 'drafts',
  path: '/communication/mail/drafts',
  title: 'Drafts',
  blurb: 'Composed but not yet sent. Drafts are private to their author until sent.',
};
const SENT_DEF: FolderDef = {
  key: 'SENT',
  tab: 'sent',
  path: '/communication/mail/sent',
  title: 'Sent',
  blurb: 'Accepted by the mail provider. Delivery is only claimed when the provider confirms it.',
};
const SCHEDULED_DEF: FolderDef = {
  key: 'SCHEDULED',
  tab: 'scheduled',
  path: '/communication/mail/scheduled',
  title: 'Scheduled',
  blurb: 'Queued for a future send time. Cancel a schedule to return the message to drafts.',
};
const ARCHIVE_DEF: FolderDef = {
  key: 'ARCHIVE',
  tab: 'archive',
  path: '/communication/mail/archive',
  title: 'Archive',
  blurb: 'Filed out of the working folders. Nothing is deleted.',
};
const SPAM_DEF: FolderDef = {
  key: 'SPAM',
  tab: 'spam',
  path: '/communication/mail/spam',
  title: 'Spam',
  blurb: 'Flagged as unsolicited. Restore a message to put it back in the inbox.',
};
const TRASH_DEF: FolderDef = {
  key: 'TRASH',
  tab: 'trash',
  path: '/communication/mail/trash',
  title: 'Trash',
  blurb: 'Deleted but recoverable. Permanent purge is a separate, audited action.',
};

const FOLDERS: FolderDef[] = [
  INBOX_DEF,
  DRAFTS_DEF,
  SENT_DEF,
  SCHEDULED_DEF,
  ARCHIVE_DEF,
  SPAM_DEF,
  TRASH_DEF,
];

function folderDef(folder: string): FolderDef {
  switch (folder.toUpperCase()) {
    case 'DRAFTS':
      return DRAFTS_DEF;
    case 'SENT':
      return SENT_DEF;
    case 'SCHEDULED':
      return SCHEDULED_DEF;
    case 'ARCHIVE':
      return ARCHIVE_DEF;
    case 'SPAM':
      return SPAM_DEF;
    case 'TRASH':
      return TRASH_DEF;
    default:
      return INBOX_DEF;
  }
}

/** The backend sorts on a real column, and the column differs per folder. */
function defaultSort(key: FolderKey): string {
  if (key === 'SENT') return 'sent_at';
  if (key === 'SCHEDULED') return 'scheduled_at';
  if (key === 'DRAFTS') return 'updated_at';
  return 'created_at';
}

/** Whitelist mirrors the backend's accepted `sort` values. */
const SORTABLE_DATE: Record<string, string> = {
  INBOX: 'created_at',
  DRAFTS: 'updated_at',
  SENT: 'sent_at',
  SCHEDULED: 'scheduled_at',
  ARCHIVE: 'created_at',
  SPAM: 'created_at',
  TRASH: 'created_at',
};

const STATUS_OPTIONS = [
  'DRAFT',
  'SCHEDULED',
  'PENDING_APPROVAL',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
];

const PRIORITY_OPTIONS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function messageDate(m: MessageListItem): unknown {
  return m.sentAt ?? m.scheduledAt ?? m.createdAt;
}

export default function MailList({ folder }: { folder: string }) {
  const def = folderDef(folder);
  const params = useHashQuery();

  const [term, setTerm] = useState<string>(() => params.get('q') ?? '');
  const [sort, setSort] = useState<string>(() => defaultSort(def.key));
  const [order, setOrder] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState<number>(() => num(params.get('page')) || 1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [status, setStatus] = useState<string>(() => params.get('status') ?? '');
  const [priority, setPriority] = useState<string>(() => params.get('priority') ?? '');
  const [read, setRead] = useState<string>(() => params.get('read') ?? '');
  const [attachments, setAttachments] = useState<string>(() => params.get('attachments') ?? '');
  const [classification, setClassification] = useState<string>(() => params.get('classification') ?? '');
  const [mailboxId, setMailboxId] = useState<string>(() => params.get('mailboxId') ?? '');

  const search = useDebounced(term, 300);

  const folderKey = def.key;

  // The workspace reuses this component when the folder changes, so folder-dependent
  // state is re-based explicitly rather than relying on a remount.
  useEffect(() => {
    setPage(1);
    setSort(defaultSort(folderKey));
    setOrder('DESC');
  }, [folderKey]);

  const query = useMemo(
    () => ({
      folder: folderKey,
      q: search.trim() || undefined,
      sort,
      order,
      page,
      pageSize,
      status: status || undefined,
      priority: priority || undefined,
      isRead: read === '' ? undefined : read === 'true',
      hasAttachments: attachments === 'true' ? true : undefined,
      classification: classification || undefined,
      mailboxId: mailboxId || undefined,
    }),
    [folderKey, search, sort, order, page, pageSize, status, priority, read, attachments, classification, mailboxId],
  );

  const list = useMailMessages(query);
  const summary = useMailSummary();
  const mailboxes = useMailboxes();
  const classes = useMailClassifications();

  // Filters live in the URL so a filtered view can be shared or reloaded. currentPath()
  // strips the query, so this cannot disturb the route the shell matches on.
  useEffect(() => {
    navigate(def.path, {
      replace: true,
      query: {
        q: search.trim(),
        page: page > 1 ? page : undefined,
        sort: sort === defaultSort(def.key) ? undefined : sort,
        order: order === 'DESC' ? undefined : order,
        status: status || undefined,
        priority: priority || undefined,
        read: read || undefined,
        attachments: attachments || undefined,
        classification: classification || undefined,
        mailboxId: mailboxId || undefined,
      },
    });
  }, [def.key, def.path, query, search, page, sort, order, status, priority, read, attachments, classification, mailboxId]);

  const rows = list.data?.rows ?? [];
  const total = num(list.data?.pagination?.total);
  const size = num(list.data?.pagination?.pageSize) || pageSize;
  const current = num(list.data?.pagination?.page) || page;
  const pageCount = Math.max(1, Math.ceil(total / (size || 25)));

  const filtersOn =
    search.trim() !== '' ||
    status !== '' ||
    priority !== '' ||
    read !== '' ||
    attachments !== '' ||
    classification !== '' ||
    mailboxId !== '';

  function clearFilters() {
    setTerm('');
    setStatus('');
    setPriority('');
    setRead('');
    setAttachments('');
    setClassification('');
    setMailboxId('');
    setPage(1);
  }

  function sortBy(key: string) {
    if (sort === key) setOrder(order === 'ASC' ? 'DESC' : 'ASC');
    else {
      setSort(key);
      setOrder('DESC');
    }
    setPage(1);
  }

  function sortHeader(key: string, label: string) {
    const on = sort === key;
    return (
      <button type="button" className="btn btn-xs btn-ghost" onClick={() => sortBy(key)}>
        {label}
        {on ? (order === 'ASC' ? ' ▲' : ' ▼') : ''}
      </button>
    );
  }

  async function toggleStar(m: MessageListItem) {
    try {
      await patchMessage(m.id, { isStarred: !m.isStarred });
      list.refresh();
    } catch (e) {
      toast.fromError('Could not update the message', e);
    }
  }

  async function toggleRead(m: MessageListItem) {
    try {
      await patchMessage(m.id, { isRead: !m.isRead });
      list.refresh();
      summary.refresh();
    } catch (e) {
      toast.fromError('Could not update the message', e);
    }
  }

  async function fileMessage(m: MessageListItem) {
    try {
      if (def.key === 'TRASH') await restoreMessage(m.id);
      else if (def.key === 'ARCHIVE') await unarchiveMessage(m.id);
      else await archiveMessage(m.id);
      list.refresh();
      summary.refresh();
      toast.success(
        def.key === 'TRASH'
          ? 'Message restored'
          : def.key === 'ARCHIVE'
            ? 'Returned to the inbox'
            : 'Message archived',
      );
    } catch (e) {
      toast.fromError('Could not move the message', e);
    }
  }

  const dateKey = SORTABLE_DATE[def.key] ?? 'created_at';

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title={def.title}
        sub={def.blurb}
        actions={
          <RefreshBtn
            onClick={() => {
              list.refresh();
              summary.refresh();
            }}
            disabled={list.loading}
          />
        }
      />
      <MailTabs active={def.tab} />

      <KpiRow>
        {FOLDERS.map((f) => (
          <KpiTile
            key={f.key}
            label={f.title}
            value={countText(summary.data?.folders?.[f.key]?.total)}
            sub={'unread ' + countText(summary.data?.folders?.[f.key]?.unread)}
            accent={f.key === folderKey ? undefined : '#64748B'}
            onClick={() => navigate(f.path)}
          />
        ))}
      </KpiRow>

      <div className="filter-bar">
        <input
          className="hk-input"
          type="search"
          aria-label="Search mail"
          placeholder="Search subject, body or address"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setPage(1);
          }}
        />

        <select
          className="hk-select"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Any state</option>
          {STATUS_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <select
          className="hk-select"
          aria-label="Priority"
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Any priority</option>
          {PRIORITY_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>

        <select
          className="hk-select"
          aria-label="Read state"
          value={read}
          onChange={(e) => {
            setRead(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Read and unread</option>
          <option value="false">Unread only</option>
          <option value="true">Read only</option>
        </select>

        <select
          className="hk-select"
          aria-label="Classification"
          value={classification}
          onChange={(e) => {
            setClassification(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Any classification</option>
          {(classes.data ?? []).map((c) => (
            <option key={c.id} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>

        <select
          className="hk-select"
          aria-label="Mailbox"
          value={mailboxId}
          onChange={(e) => {
            setMailboxId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All mailboxes</option>
          {(mailboxes.data ?? []).map((mb) => (
            <option key={mb.id} value={String(mb.id)}>
              {mb.address}
            </option>
          ))}
        </select>

        <label className="stack-row" style={{ alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={attachments === 'true'}
            onChange={(e) => {
              setAttachments(e.target.checked ? 'true' : '');
              setPage(1);
            }}
          />
          <span>With attachments</span>
        </label>

        {filtersOn ? (
          <div className="chips">
            <button type="button" className="chip" onClick={clearFilters}>
              Clear all filters
            </button>
          </div>
        ) : null}
      </div>

      {list.error ? <ErrorBanner error={list.error} /> : null}

      <SecCard
        title={def.title}
        sub={
          countText(total) +
          ' matching · page ' +
          countText(current) +
          ' of ' +
          countText(pageCount)
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">{sortHeader('subject', 'Subject')}</th>
                <th scope="col">State</th>
                <th scope="col">Classification</th>
                <th scope="col">{sortHeader(dateKey, 'Date')}</th>
                <th scope="col" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow cols={6}>
                  <Nothing
                    text={
                      list.loading
                        ? 'Loading messages…'
                        : 'No messages in ' + def.title.toLowerCase() + (filtersOn ? ' match the current filters.' : ' yet.')
                    }
                    action={filtersOn && !list.loading ? 'Clear filters' : undefined}
                    onAction={filtersOn && !list.loading ? clearFilters : undefined}
                  />
                </EmptyRow>
              ) : (
                rows.map((m) => {
                  const dv = deliveryView(m.status, null, []);
                  const href = '#/communication/mail/message/' + m.id;
                  return (
                    <tr key={m.id} className={m.isRead ? undefined : 'com-unread'}>
                      <td>
                        <div className="cell-main">{s(m.fromName) || s(m.fromEmail) || '—'}</div>
                        <div className="cell-sub">{s(m.fromEmail)}</div>
                      </td>
                      <td>
                        <a className="cell-main" href={href}>
                          {truncate(m.subject, 90) || '(no subject)'}
                        </a>
                        <div className="cell-sub">{truncate(m.snippet, 120)}</div>
                        {m.mailboxAddress ? <div className="cell-sub">{s(m.mailboxAddress)}</div> : null}
                      </td>
                      <td>
                        <ToneBadge tone={dv.tone} label={dv.label} title={dv.detail} />
                        {m.approvalState && m.approvalState !== 'NONE' ? (
                          <div className="cell-sub">
                            {'Approval ' + m.approvalState.replace(/_/g, ' ').toLowerCase()}
                          </div>
                        ) : null}
                        {m.hasAttachments ? (
                          <div className="cell-sub">{countText(m.attachmentCount ?? 1) + ' attachment(s)'}</div>
                        ) : null}
                      </td>
                      <td>
                        <ToneBadge
                          tone={classificationTone(m.classification)}
                          label={s(m.classification) || '—'}
                        />
                        {m.isStarred ? <div className="cell-sub">Starred</div> : null}
                        {m.isImportant ? <div className="cell-sub">Important</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{whenText(messageDate(m))}</div>
                        {m.priority && m.priority !== 'NORMAL' ? (
                          <div className="cell-sub">{s(m.priority)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn-xs btn-ghost" onClick={() => void toggleStar(m)}>
                            {m.isStarred ? 'Unstar' : 'Star'}
                          </button>
                          <button type="button" className="btn btn-xs btn-ghost" onClick={() => void toggleRead(m)}>
                            {m.isRead ? 'Mark unread' : 'Mark read'}
                          </button>
                          {def.key === 'DRAFTS' ? (
                            <button
                              type="button"
                              className="btn btn-xs btn-ghost"
                              onClick={() => navigate('/communication/mail/compose/' + m.id)}
                            >
                              Continue
                            </button>
                          ) : (
                            <button type="button" className="btn btn-xs btn-ghost" onClick={() => void fileMessage(m)}>
                              {def.key === 'TRASH' ? 'Restore' : def.key === 'ARCHIVE' ? 'Unarchive' : 'Archive'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pager
          page={current}
          pageSize={size}
          total={total}
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      </SecCard>
    </div>
  );
}
