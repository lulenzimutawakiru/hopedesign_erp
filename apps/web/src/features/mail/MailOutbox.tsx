/**
 * Company mail - outbox and send queue.
 *
 * The outbox is the delivery ledger: one row per queued send attempt, with the
 * attempt count the worker has actually made. `attempts >= maxAttempts` means
 * the queue has given up, so Retry is disabled there rather than offered as a
 * button that the API would answer with 409.
 *
 * The list is filtered and paged by Postgres (`GET /outbox` owns `status`,
 * `page` and `pageSize`). The screen never filters a loaded page in the browser
 * and never claims a delivery the provider has not confirmed - the status
 * column is the queue's own state.
 */
import { useEffect, useMemo, useState } from 'react';
import { can, useAuth } from '../../auth';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, PageLoader, Pager } from '../../components/ui';
import { toast } from '../../components/toast';
import { retryOutbox } from './mailApi';
import { useMailOutbox, useMailboxes } from './useMail';
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
import { outboxStatusView } from './mailDelivery';
import type { OutboxRow } from './mail.types';

const PATH = '/communication/mail/outbox';

/** Mirrors the lifecycle statuses the message table can hold. */
const STATUS_OPTIONS = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'SCHEDULED',
  'PENDING_APPROVAL',
  'CANCELLED',
];

export default function MailOutbox() {
  const { user } = useAuth();
  const params = useHashQuery();

  const [status, setStatus] = useState<string>(() => params.get('status') ?? '');
  const [page, setPage] = useState<number>(() => num(params.get('page')) || 1);
  const [pageSize, setPageSize] = useState<number>(() => num(params.get('pageSize')) || 25);
  const [busy, setBusy] = useState<number>(0);

  const query = useMemo(
    () => ({ status: status || undefined, page, pageSize }),
    [status, page, pageSize]
  );

  const list = useMailOutbox(query);
  const mailboxes = useMailboxes();

  const canRetry = can(user, 'communication.mail_scheduler.manage');

  // Filter and page live in the URL so a reload lands on the same view.
  useEffect(() => {
    navigate(PATH, {
      replace: true,
      query: {
        status: status || undefined,
        page: page > 1 ? page : undefined,
        pageSize: pageSize === 25 ? undefined : pageSize,
      },
    });
  }, [status, page, pageSize]);

  const rows = list.data?.rows ?? [];
  const total = num(list.data?.pagination?.total);
  const size = num(list.data?.pagination?.pageSize) || pageSize;
  const current = num(list.data?.pagination?.page) || page;

  const failedShown = rows.filter((row) => s(row.status).toUpperCase() === 'FAILED').length;
  const exhaustedShown = rows.filter(
    (row) => num(row.attempts) >= num(row.maxAttempts) && num(row.maxAttempts) > 0
  ).length;

  function mailboxLabel(id: number | null): string {
    if (id === null) return '';
    const found = (mailboxes.data ?? []).find((box) => num(box.id) === num(id));
    return found ? s(found.address) || s(found.displayName) : '';
  }

  async function retry(row: OutboxRow) {
    if (busy) return;
    setBusy(row.id);
    try {
      const outcome = await retryOutbox(row.id);
      list.refresh();
      toast.success(
        'Retry handed to the mail provider (' + s(outcome?.outcome).toLowerCase() + ')'
      );
    } catch (e) {
      toast.fromError('Could not retry the queued message', e);
    } finally {
      setBusy(0);
    }
  }

  if (list.loading && !list.data) return <PageLoader label="Loading the outbox" />;

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title="Outbox"
        sub="The send queue. A message sits here until the mail provider accepts it; delivery is only claimed when the provider confirms it."
        actions={<RefreshBtn onClick={list.refresh} disabled={list.loading} />}
      />
      <MailTabs active="outbox" />

      <ErrorBanner error={list.error} />

      <KpiRow>
        <KpiTile label="Queue rows" value={countText(total)} sub="matching the filter" />
        <KpiTile
          label="Send failed"
          value={countText(failedShown)}
          sub="within the rows shown"
          accent="#B91C1C"
          tint="rgba(185, 28, 28, 0.12)"
        />
        <KpiTile
          label="Attempts exhausted"
          value={countText(exhaustedShown)}
          sub="within the rows shown"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
        />
      </KpiRow>

      <div className="filter-bar">
        <label className="field" style={{ margin: 0 }}>
          <span>Status</span>
          <select
            className="hk-select"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>

      <SecCard
        title="Queue entries"
        sub="Newest first. Retry is only available while the queue still has attempts left."
        actions={<RefreshBtn onClick={list.refresh} disabled={list.loading} />}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">State</th>
                <th scope="col">Attempts</th>
                <th scope="col">Queued</th>
                <th scope="col">Next attempt</th>
                <th scope="col">Sent</th>
                <th scope="col" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow cols={7}>
                  <Nothing
                    text={
                      list.loading
                        ? 'Loading the outbox\u2026'
                        : status
                          ? 'No queue rows have status ' + status + '.'
                          : 'Nothing is queued for sending.'
                    }
                    action={status && !list.loading ? 'Clear filter' : undefined}
                    onAction={
                      status && !list.loading
                        ? () => {
                            setStatus('');
                            setPage(1);
                          }
                        : undefined
                    }
                  />
                </EmptyRow>
              ) : (
                rows.map((row) => {
                  const view = outboxStatusView(row.status);
                  const attempts = num(row.attempts);
                  const max = num(row.maxAttempts);
                  const exhausted = max > 0 && attempts >= max;
                  return (
                    <tr key={row.id}>
                      <td>
                        <a className="cell-main" href={'#/communication/mail/message/' + row.emailId}>
                          {truncate(row.subject, 80) || '(no subject)'}
                        </a>
                        <div className="cell-sub">
                          {mailboxLabel(row.mailboxId) ||
                            (row.mailboxId !== null ? 'Mailbox ' + row.mailboxId : '\u2014')}
                        </div>
                      </td>
                      <td>
                        <ToneBadge tone={view.tone} label={view.label} />
                        {s(row.emailStatus) ? (
                          <div className="cell-sub">{'Message ' + s(row.emailStatus)}</div>
                        ) : null}
                        {s(row.classification) ? (
                          <div className="cell-sub">{s(row.classification)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="cell-main">
                          {countText(attempts) + ' / ' + (max > 0 ? countText(max) : '\u2014')}
                        </div>
                        {s(row.lastError) ? (
                          <div className="cell-sub">{truncate(row.lastError, 120)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="cell-main">{whenText(row.queuedAt)}</div>
                        {s(row.priority) && s(row.priority).toUpperCase() !== 'NORMAL' ? (
                          <div className="cell-sub">{s(row.priority)}</div>
                        ) : null}
                      </td>
                      <td>
                        {row.sentAt
                          ? 'Sent'
                          : exhausted
                            ? 'Gave up'
                            : whenText(row.nextAttemptAt)}
                      </td>
                      <td>
                        <div className="cell-main">{whenText(row.sentAt)}</div>
                        {s(row.provider) ? <div className="cell-sub">{s(row.provider)}</div> : null}
                        {s(row.providerMessageId) ? (
                          <div className="cell-sub">{truncate(row.providerMessageId, 40)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            disabled={!canRetry || exhausted || busy === row.id}
                            title={
                              !canRetry
                                ? 'You do not have permission to manage the mail scheduler.'
                                : exhausted
                                  ? 'The queue has used every attempt for this message.'
                                  : undefined
                            }
                            onClick={() => void retry(row)}
                          >
                            {busy === row.id ? 'Retrying\u2026' : 'Retry'}
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
