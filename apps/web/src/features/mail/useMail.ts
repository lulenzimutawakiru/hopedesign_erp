/**
 * Company Mailing System - data hooks.
 *
 * Every hook returns the same shape ({ data, loading, error, refresh }) so the
 * mail screens render one consistent loading / error / empty treatment instead
 * of each inventing its own.
 *
 * There is deliberately no cache of live business state here: a message's
 * status, approval state and confirmed delivery state are read from Postgres on
 * every mount and every refresh. A superseded request is discarded rather than
 * applied (the `isStale` guard), so a slow response can never overwrite a newer
 * one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as mailApi from './mailApi';
import { qs } from './mailApi';
import type {
  DistributionList,
  DistributionMember,
  MailboxDelegation,
  MailboxMember,
  MailboxView,
  MailClassification,
  MailEntityType,
  MailListResponse,
  MailSignature,
  MailSummary,
  MessageDetailBody,
  MessageListItem,
  OutboxRow,
  PendingApprovalRow,
  Rec,
} from './mail.types';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  refresh: () => void;
}

/**
 * Single-flight async loader. `key` is the serialized request - when it changes
 * the loader runs again. `enabled: false` skips the request entirely and leaves
 * `data` null, which is what the detail hooks use before an id is known.
 */
function useAsync<T>(
  key: string,
  load: () => Promise<T>,
  options?: { enabled?: boolean }
): AsyncState<T> {
  const enabled = options?.enabled !== false;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let dead = false;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((result) => {
        if (!dead) setData(result);
      })
      .catch((err) => {
        if (!dead) setError(err);
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [key, enabled, tick]);

  return { data, loading, error, refresh };
}

/** Trailing debounce - used for the free-text filters so typing does not spam the API. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Single-flight mutation wrapper. Guards against duplicate submissions (a
 * double-clicked Send cannot post twice) and re-throws so the caller can show
 * the real backend message rather than a silent failure.
 */
export function useMailAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>
): {
  run: (...args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: unknown;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      return await actionRef.current(...args);
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export const useMailboxes = (kind?: string): AsyncState<MailboxView[]> =>
  useAsync('mailboxes:' + (kind ?? 'all'), () => mailApi.listMailboxes(kind));

export const useMailbox = (id: number | string | null): AsyncState<MailboxView> => {
  const hasId = id !== null && id !== '';
  return useAsync(
    'mailbox:' + String(id ?? ''),
    () => mailApi.getMailbox(id as number | string),
    { enabled: hasId }
  );
};

export const useMailMembers = (mailboxId: number | string | null): AsyncState<MailboxMember[]> => {
  const hasId = mailboxId !== null && mailboxId !== '';
  return useAsync(
    'members:' + String(mailboxId ?? ''),
    () => mailApi.listMembers(mailboxId as number | string),
    { enabled: hasId }
  );
};

export const useMailDelegations = (
  mailboxId: number | string | null
): AsyncState<MailboxDelegation[]> => {
  const hasId = mailboxId !== null && mailboxId !== '';
  return useAsync(
    'delegations:' + String(mailboxId ?? ''),
    () => mailApi.listDelegations(mailboxId as number | string),
    { enabled: hasId }
  );
};

export const useMailLabels = (mailboxId: number | string | null): AsyncState<Rec[]> => {
  const hasId = mailboxId !== null && mailboxId !== '';
  return useAsync(
    'labels:' + String(mailboxId ?? ''),
    () => mailApi.listLabels(mailboxId as number | string),
    { enabled: hasId }
  );
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MailMessageQuery {
  folder?: string;
  mailboxId?: number | string;
  classification?: string;
  priority?: string;
  status?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  hasAttachments?: boolean;
  entityType?: string;
  entityId?: number | string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  sort?: string;
  order?: 'ASC' | 'DESC';
  page?: number;
  pageSize?: number;
}

export const useMailSummary = (mailboxId?: number | string): AsyncState<MailSummary> =>
  useAsync('summary:' + String(mailboxId ?? 'all'), () => mailApi.mailSummary(mailboxId));

/** The list is paged, filtered and sorted by Postgres - never in the browser. */
export const useMailMessages = (
  query: MailMessageQuery
): AsyncState<MailListResponse<MessageListItem>> => {
  const key = 'messages:' + qs({ ...query });
  return useAsync(key, () => mailApi.listMessages({ ...query }));
};

export const useMailMessage = (
  id: number | string | null
): AsyncState<MessageDetailBody> => {
  const hasId = id !== null && id !== '';
  return useAsync(
    'message:' + String(id ?? ''),
    () => mailApi.getMessage(id as number | string),
    { enabled: hasId }
  );
};

export const useMailOutbox = (
  query: Record<string, unknown> = {}
): AsyncState<MailListResponse<OutboxRow>> =>
  useAsync('outbox:' + qs(query), () => mailApi.listOutbox(query));

export const useMailAudit = (
  query: Record<string, unknown> = {}
): AsyncState<MailListResponse<Rec>> =>
  useAsync('audit:' + qs(query), () => mailApi.listAudit(query));

/** A blank term is refused by the API, so the request stays disabled until it is meaningful. */
export const useMailSearch = (
  term: string,
  limit = 25
): AsyncState<{ rows: MessageListItem[]; limit: number; truncated: boolean }> => {
  const q = term.trim();
  return useAsync('search:' + q + ':' + limit, () => mailApi.searchMessages(q, limit), {
    enabled: q.length >= 2,
  });
};

// ---------------------------------------------------------------------------
// Approvals, signatures, distribution, classifications
// ---------------------------------------------------------------------------

export const useMailApprovals = (
  query: Record<string, unknown> = {}
): AsyncState<{ approvals: PendingApprovalRow[]; actionableCount: number }> =>
  useAsync('approvals:' + qs(query), () => mailApi.listApprovals(query));

export const useMailSignatures = (
  mailboxId?: number | string
): AsyncState<{ signatures: MailSignature[]; defaultSignature: MailSignature | null }> =>
  useAsync('signatures:' + String(mailboxId ?? 'all'), () => mailApi.listSignatures(mailboxId));

export const useMailDistributionLists = (): AsyncState<DistributionList[]> =>
  useAsync('distribution-lists', () => mailApi.listDistributionLists());

export const useMailDistributionMembers = (
  listId: number | string | null
): AsyncState<DistributionMember[]> => {
  const hasId = listId !== null && listId !== '';
  return useAsync(
    'distribution-members:' + String(listId ?? ''),
    () => mailApi.listDistributionMembers(listId as number | string),
    { enabled: hasId }
  );
};

export const useMailClassifications = (): AsyncState<MailClassification[]> =>
  useAsync('classifications', () => mailApi.listClassifications());

/**
 * Document types the caller may link a message to. One shared request - the
 * list is small, permission-derived and valid for the whole session.
 */
export const useMailEntityTypes = (): AsyncState<MailEntityType[]> =>
  useAsync('entity-types', () => mailApi.listMailEntityTypes());
