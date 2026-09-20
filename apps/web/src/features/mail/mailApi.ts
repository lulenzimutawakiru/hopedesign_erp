/**
 * Company Mailing System - API client.
 *
 * One wrapper per backend route in `apps/api/src/routes/ops/mail.ts`.
 * Every response is unwrapped from the `{ data: ... }` envelope that `run()`/`runGet()`
 * produce. Nothing here invents a value the API did not return, and nothing here
 * filters or sorts client-side - the list endpoints do that in Postgres.
 */
import { api, getToken } from '../../api';
import type {
  DeliveryEvent,
  DistributionList,
  DistributionMember,
  EmailApprovalRow,
  MailClassification,
  MailEntityType,
  MailboxDelegation,
  MailboxMember,
  MailboxView,
  MailListResponse,
  MailSignature,
  MailSummary,
  MessageAttachment,
  MessageDetailBody,
  MessageListItem,
  OutboxRow,
  PendingApprovalRow,
  ProviderConfig,
  Rec,
  SendOutcome,
} from './mail.types';

const BASE = '/api/ops/mail';

interface Envelope<T> {
  data?: T;
}

/** Unwrap `{ data: X }`; tolerate a bare payload so a shape change cannot blank a screen. */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const body = await api<Envelope<T>>(BASE + path, init);
  if (body && typeof body === 'object' && 'data' in body && (body as Envelope<T>).data !== undefined) {
    return (body as Envelope<T>).data as T;
  }
  return body as unknown as T;
}

const get = <T>(path: string) => call<T>(path);
const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
const del = <T>(path: string) => call<T>(path, { method: 'DELETE' });

/** Build a query string, dropping empty/nullish values so the URL stays meaningful. */
export function qs(params: Record<string, unknown> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export const listMailboxes = (kind?: string) =>
  get<{ mailboxes: MailboxView[] }>('/mailboxes' + qs({ kind })).then((r) => r.mailboxes ?? []);

export const getMailbox = (id: number | string) => get<MailboxView>('/mailboxes/' + id);

export const createMailbox = (body: Rec) => post<Rec>('/mailboxes', body);
export const updateMailbox = (id: number | string, body: Rec) => patch<Rec>('/mailboxes/' + id, body);

// ---------------------------------------------------------------------------
// Mailbox members and delegations
// ---------------------------------------------------------------------------

export const listMembers = (mailboxId: number | string) =>
  get<{ members: MailboxMember[] }>(`/mailboxes/${mailboxId}/members`).then((r) => r.members ?? []);

export const addMember = (mailboxId: number | string, body: Rec) =>
  post<Rec>(`/mailboxes/${mailboxId}/members`, body);

export const updateMember = (mailboxId: number | string, userId: number | string, body: Rec) =>
  patch<Rec>(`/mailboxes/${mailboxId}/members/${userId}`, body);

export const removeMember = (mailboxId: number | string, userId: number | string) =>
  del<Rec>(`/mailboxes/${mailboxId}/members/${userId}`);

export const listDelegations = (mailboxId: number | string) =>
  get<{ delegations: MailboxDelegation[] }>(`/mailboxes/${mailboxId}/delegations`).then(
    (r) => r.delegations ?? []
  );

export const createDelegation = (mailboxId: number | string, body: Rec) =>
  post<Rec>(`/mailboxes/${mailboxId}/delegations`, body);

export const revokeDelegation = (id: number | string) => post<Rec>(`/delegations/${id}/revoke`);

// ---------------------------------------------------------------------------
// Classifications
// ---------------------------------------------------------------------------

export const listClassifications = () =>
  get<{ classifications: MailClassification[] }>('/classifications').then(
    (r) => r.classifications ?? []
  );

export const updateClassification = (id: number | string, body: Rec) =>
  patch<Rec>('/classifications/' + id, body);

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

/**
 * The ERP document types the caller may attach to a message. The server
 * filters by each renderer's own permission, so whatever comes back is
 * genuinely attachable by this user.
 */
export const listMailEntityTypes = () =>
  get<{ entityTypes: MailEntityType[] }>('/entity-types').then((r) => r.entityTypes ?? []);

// ---------------------------------------------------------------------------
// Message lists
// ---------------------------------------------------------------------------

export const mailSummary = (mailboxId?: number | string) =>
  get<MailSummary>('/messages/summary' + qs({ mailboxId }));

export const listMessages = (query: Record<string, unknown> = {}) =>
  get<MailListResponse<MessageListItem>>('/messages' + qs(query));

export const getMessage = (id: number | string) => get<MessageDetailBody>('/messages/' + id);

export const patchMessage = (id: number | string, body: Rec) =>
  patch<{ message: Rec }>('/messages/' + id, body).then((r) => r.message);

export const archiveMessage = (id: number | string) => post<Rec>(`/messages/${id}/archive`);
export const unarchiveMessage = (id: number | string) => post<Rec>(`/messages/${id}/unarchive`);
export const restoreMessage = (id: number | string) => post<Rec>(`/messages/${id}/restore`);
export const moveMessage = (id: number | string, body: Rec) => post<Rec>(`/messages/${id}/move`, body);
export const deleteMessage = (id: number | string) => del<Rec>('/messages/' + id);
export const purgeMessage = (id: number | string) => post<Rec>(`/messages/${id}/purge`);

// ---------------------------------------------------------------------------
// Drafts, send, schedule
// ---------------------------------------------------------------------------

export const createDraft = (body: Rec) => post<Rec>('/messages', body);
export const updateDraft = (id: number | string, body: Rec) => patch<Rec>(`/messages/${id}/draft`, body);
export const sendMessage = (id: number | string, body: Rec) =>
  post<SendOutcome>(`/messages/${id}/send`, body);
export const scheduleMessage = (id: number | string, body: Rec) =>
  post<Rec>(`/messages/${id}/schedule`, body);
export const unscheduleMessage = (id: number | string) => post<Rec>(`/messages/${id}/unschedule`);

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export const listOutbox = (query: Record<string, unknown> = {}) =>
  get<MailListResponse<OutboxRow>>('/outbox' + qs(query));

export const retryOutbox = (id: number | string) => post<SendOutcome>(`/outbox/${id}/retry`);

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const submitApproval = (messageId: number | string, body: Rec) =>
  post<Rec>(`/messages/${messageId}/approvals`, body);

export const listMessageApprovals = (messageId: number | string) =>
  get<{ approvals: EmailApprovalRow[] }>(`/messages/${messageId}/approvals`).then(
    (r) => r.approvals ?? []
  );

export const listApprovals = (query: Record<string, unknown> = {}) =>
  get<{ approvals: PendingApprovalRow[]; actionableCount: number }>('/approvals' + qs(query));

export const approveApproval = (id: number | string, note?: string) =>
  post<Rec>(`/approvals/${id}/approve`, { decisionNote: note ?? '' });

export const rejectApproval = (id: number | string, note: string) =>
  post<Rec>(`/approvals/${id}/reject`, { decisionNote: note });

export const returnApproval = (id: number | string, note: string) =>
  post<Rec>(`/approvals/${id}/return`, { decisionNote: note });

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const listSignatures = (mailboxId?: number | string) =>
  get<{ signatures: MailSignature[]; defaultSignature: MailSignature | null }>(
    '/signatures' + qs({ mailboxId })
  );

export const createSignature = (body: Rec) =>
  post<{ signature: MailSignature }>('/signatures', body).then((r) => r.signature);

export const updateSignature = (id: number | string, body: Rec) =>
  patch<{ signature: MailSignature }>('/signatures/' + id, body).then((r) => r.signature);

export const deleteSignature = (id: number | string) => del<Rec>('/signatures/' + id);
export const setDefaultSignature = (id: number | string) =>
  post<{ signature: MailSignature }>(`/signatures/${id}/default`).then((r) => r.signature);

// ---------------------------------------------------------------------------
// Distribution lists
// ---------------------------------------------------------------------------

export const listDistributionLists = () =>
  get<{ lists: DistributionList[] }>('/distribution-lists').then((r) => r.lists ?? []);

export const createDistributionList = (body: Rec) =>
  post<{ list: DistributionList }>('/distribution-lists', body).then((r) => r.list);

export const updateDistributionList = (id: number | string, body: Rec) =>
  patch<{ list: DistributionList }>('/distribution-lists/' + id, body).then((r) => r.list);

export const deleteDistributionList = (id: number | string) => del<Rec>('/distribution-lists/' + id);

export const listDistributionMembers = (id: number | string) =>
  get<{ members: DistributionMember[] }>(`/distribution-lists/${id}/members`).then(
    (r) => r.members ?? []
  );

export const addDistributionMember = (id: number | string, body: Rec) =>
  post<{ member: DistributionMember }>(`/distribution-lists/${id}/members`, body).then(
    (r) => r.member
  );

export const removeDistributionMember = (id: number | string, memberId: number | string) =>
  del<Rec>(`/distribution-lists/${id}/members/${memberId}`);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const listLabels = (mailboxId: number | string) =>
  get<{ labels: Rec[] }>(`/mailboxes/${mailboxId}/labels`).then((r) => r.labels ?? []);

export const createLabel = (mailboxId: number | string, body: Rec) =>
  post<{ label: Rec }>(`/mailboxes/${mailboxId}/labels`, body).then((r) => r.label);

export const updateLabel = (id: number | string, body: Rec) =>
  patch<{ label: Rec }>('/labels/' + id, body).then((r) => r.label);

export const deleteLabel = (id: number | string) => del<Rec>('/labels/' + id);

export const applyLabel = (messageId: number | string, labelId: number | string) =>
  post<Rec>(`/messages/${messageId}/labels`, { labelId });

export const removeLabel = (messageId: number | string, labelId: number | string) =>
  del<Rec>(`/messages/${messageId}/labels/${labelId}`);

// ---------------------------------------------------------------------------
// Delivery, audit, search
// ---------------------------------------------------------------------------

export const deliveryEvents = (messageId: number | string) =>
  get<{ events: DeliveryEvent[]; providerStatus: string | null }>(
    `/messages/${messageId}/delivery-events`
  );

export const listAudit = (query: Record<string, unknown> = {}) =>
  get<MailListResponse<Rec>>('/audit' + qs(query));

export const searchMessages = (q: string, limit?: number) =>
  get<{ rows: MessageListItem[]; limit: number; truncated: boolean }>('/search' + qs({ q, limit }));

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const attachErpDocument = (messageId: number | string, body: Rec) =>
  post<MessageAttachment>(`/messages/${messageId}/attachments/erp`, body);

export const uploadAttachment = async (messageId: number | string, file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return call<MessageAttachment>(`/messages/${messageId}/attachments`, { method: 'POST', body: fd });
};

export const deleteAttachment = (id: number | string) => del<Rec>('/attachments/' + id);

/**
 * Attachments are streamed outside the JSON envelope, so they cannot go through `api()`.
 * The bytes are fetched with the bearer token and handed to the browser as a blob URL.
 */
export async function downloadAttachment(id: number | string, fileName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${BASE}/attachments/${id}/download`, {
    headers: token ? { Authorization: 'Bearer ' + token } : undefined,
  });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error?.message ?? message;
    } catch {
      /* the response was not JSON - keep the status-based message */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const listProviderConfigs = () =>
  get<{ rows: ProviderConfig[] }>('/provider-configs').then((r) => r.rows ?? []);

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/** A tenant user as returned by the mail-scoped identity lookup. */
export interface DirectoryUser {
  id: number;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string | null;
}

/**
 * Identity lookup for the member and delegation pickers.
 * Returns identity fields only - never roles, sessions or MFA state.
 */
export const searchDirectoryUsers = (q: string) =>
  get<DirectoryUser[]>('/directory/users' + qs({ q })).then((r) => (Array.isArray(r) ? r : []));
