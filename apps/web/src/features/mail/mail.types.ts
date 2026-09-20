/**
 * Company Mailing System - domain types.
 *
 * These mirror the shapes returned by `apps/api/src/routes/ops/mail.ts` verbatim.
 * Fields the API does not project are marked optional rather than defaulted, so the
 * UI can tell "not returned" apart from "empty" - and never invents a value.
 */

export type Rec = Record<string, unknown>;

/** The eight workspace folders the backend accepts on `GET /messages?folder=`. */
export type FolderKey =
  | 'INBOX'
  | 'SENT'
  | 'DRAFTS'
  | 'SCHEDULED'
  | 'OUTBOX'
  | 'ARCHIVE'
  | 'TRASH'
  | 'SPAM';

export interface MailboxPermissions {
  canView: boolean;
  canSend: boolean;
  canReply: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canDelegate: boolean;
  canExport: boolean;
  canAdmin: boolean;
}

/** `mailboxView()` - the projection returned by GET /mailboxes and /mailboxes/:id. */
export interface MailboxView {
  id: number;
  code: string;
  address: string;
  displayName: string;
  kind: string;
  departmentId: number | null;
  ownerUserId: number | null;
  description: string | null;
  defaultClassification: string | null;
  defaultSenderName: string | null;
  allowExternalSend: boolean;
  requireApproval: boolean;
  isActive: boolean;
  permissions: MailboxPermissions;
  memberRole: string | null;
  viaDelegation: boolean;
  delegationId: number | null;
  onBehalfOfUserId: number | null;
  onBehalfOfName: string | null;
  globalAdmin: boolean;
}

export interface MailboxMember {
  id: number;
  mailboxId: number;
  userId: number;
  memberRole: string;
  canView?: boolean;
  canSend?: boolean;
  canReply?: boolean;
  canDelete?: boolean;
  canArchive?: boolean;
  canDelegate?: boolean;
  canExport?: boolean;
  canAdmin?: boolean;
  isActive?: boolean;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  email?: string | null;
}

export interface MailboxDelegation {
  id: number;
  mailboxId: number;
  delegatorUserId?: number;
  delegateUserId: number;
  permissions?: string | null;
  canSendOnBehalf?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  reason?: string | null;
  status: string;
  revokedAt?: string | null;
  delegateFirstName?: string | null;
  delegateLastName?: string | null;
  delegateEmail?: string | null;
}

/** One row of `GET /messages` - the list projection, which excludes the full body. */
export interface MessageListItem {
  id: number;
  mailboxId: number | null;
  threadId: number | null;
  direction: string;
  subject: string | null;
  status: string;
  folder: string;
  classification: string | null;
  priority: string;
  approvalState: string | null;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isSpam: boolean;
  hasAttachments: boolean;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  entityType: string | null;
  entityId: number | null;
  fromEmail: string | null;
  fromName: string | null;
  createdBy: number | null;
  sentBy: number | null;
  onBehalfOf: number | null;
  version: number | null;
  providerMessageId: string | null;
  inReplyTo: string | null;
  deletedAt: string | null;
  snippet: string | null;
  mailboxCode?: string | null;
  mailboxAddress?: string | null;
  mailboxName?: string | null;
  ownerName?: string | null;
  attachmentCount?: number | null;
  recipientCount?: number | null;
}

export interface FolderSummary {
  total: number;
  unread: number;
  starred: number;
  pendingApproval: number;
}

export interface MailSummary {
  folders: Record<FolderKey, FolderSummary>;
  mailboxCount: number;
}

export interface MessageRecipient {
  id: number;
  kind: string;
  email: string;
  name: string | null;
  status: string;
  providerMessageId: string | null;
  error: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string | null;
}

export interface MessageAttachment {
  id: number;
  fileName: string;
  fileType: string | null;
  fileSize: number | null;
  source: string;
  scanStatus: string | null;
  dmsDocumentId: number | null;
  entityType: string | null;
  entityId: number | null;
  contentHash: string | null;
  uploadedBy: number | null;
  isInline: boolean;
  createdAt: string | null;
  uploaderFirstName?: string | null;
  uploaderLastName?: string | null;
}

export interface MessageLabel {
  id: number;
  name: string;
  color: string | null;
}

/** `EmailApprovalRow` - already camel-cased by the service, do not re-map. */
export interface EmailApprovalRow {
  id: number;
  emailId: number;
  emailSubject: string | null;
  emailFolder: string | null;
  emailStatus: string | null;
  emailMailboxId: number | null;
  requiredLevel: number | null;
  approverRole: string | null;
  approverUserId: number | null;
  approverName: string | null;
  status: string;
  classification: string | null;
  reason: string | null;
  decisionNote: string | null;
  requestedBy: number | null;
  requesterName: string | null;
  requestedAt: string | null;
  decidedBy: number | null;
  deciderName: string | null;
  decidedAt: string | null;
}

export type ApprovalBlockReason =
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'EARLIER_STEP_PENDING'
  | 'ALREADY_DECIDED_EARLIER_STEP';

export interface PendingApprovalRow extends EmailApprovalRow {
  actionable: boolean;
  blockedReason: ApprovalBlockReason | null;
}

/** `DeliveryEventRow` - already camel-cased by the service, do not re-map. */
export interface DeliveryEvent {
  id: number;
  emailId: number;
  recipientId: number | null;
  eventType: string;
  provider: string | null;
  providerMessageId: string | null;
  occurredAt: string;
  detail: string | null;
  confirmedByProvider: boolean;
}

export interface MessageAuditRow {
  id: number;
  userId: number | null;
  action: string;
  detail: string | null;
  mailboxId: number | null;
  messageId: number | null;
  device: string | null;
  result: string | null;
  ip: string | null;
  createdAt: string;
}

export interface EmailThread {
  id: number;
  subject: string | null;
  messageCount: number;
  unreadCount: number;
  lastDirection: string | null;
  lastMessageAt: string | null;
}

/** The action gates returned alongside a message. A non-null string is the reason. */
export interface MessagePolicy {
  forward: string | null;
  download: string | null;
  print: string | null;
  export: string | null;
}

export interface MessageDetailBody {
  message: MessageDetail;
  mailbox: MailboxView | null;
  mailboxPermissions: MailboxPermissions | null;
  classification: MailClassification | null;
  policy: MessagePolicy;
  /** null until a delivery event is confirmed by the provider - absence is not failure. */
  confirmedDeliveryStatus: string | null;
  recipients: MessageRecipient[];
  attachments: MessageAttachment[];
  labels: MessageLabel[];
  approvals: EmailApprovalRow[];
  deliveryEvents: DeliveryEvent[];
  thread: EmailThread | null;
  audit: MessageAuditRow[];
}

/**
 * The full email row returned by GET /messages/:id - the list projection plus the
 * body columns. The detail endpoint projects the same row the list does, so this
 * extends MessageListItem rather than redeclaring it; the extra keys are the ones
 * only the detail read returns. The index signature keeps a future column readable
 * without a type change, but nothing here is defaulted - an absent field stays absent.
 */
export interface MessageDetail extends MessageListItem {
  body: string | null;
  html: string | null;
  replyTo: string | null;
  signatureId: number | null;
  scheduledBy: number | null;
  approvalId: number | null;
  retentionUntil: string | null;
  /** Any further column the backend projects; never assumed present. */
  [key: string]: unknown;
}

export interface MailClassification {
  id: number | string;
  code: string;
  label: string;
  rank: number;
  color: string | null;
  description: string | null;
  allowForward: boolean;
  allowDownload: boolean;
  allowPrint: boolean;
  allowExport: boolean;
  allowExternal: boolean;
  requireApproval: boolean;
  requireEncryption: boolean;
  minRoleRank: number | null;
}

export interface MailSignature {
  id: number;
  name: string;
  body?: string | null;
  html?: string | null;
  mailboxId: number | null;
  userId: number | null;
  isShared: boolean;
  isActive: boolean;
  isDefault?: boolean;
}

/**
 * One ERP document type a message may be linked to. `entityType` is the value
 * to store on the message: it is the exact key the server folds onto a
 * document renderer, so sending it back unchanged is what lets the generated
 * PDF attach itself on send.
 */
export interface MailEntityType {
  entityType: string;
  label: string;
  permission: string;
}
export interface DistributionList {
  id: number;
  code: string;
  name: string;
  description: string | null;
  address: string | null;
  isActive: boolean;
  memberCount: number;
}

export interface DistributionMember {
  id: number;
  listId: number;
  memberType: string;
  userId: number | null;
  mailboxId: number | null;
  departmentId: number | null;
  email: string | null;
  name?: string | null;
  isActive: boolean;
}

export interface OutboxRow {
  id: number;
  emailId: number;
  mailboxId: number | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  provider: string | null;
  providerMessageId: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  subject: string | null;
  emailStatus: string | null;
  folder: string | null;
  priority: string | null;
  classification: string | null;
  scheduledAt: string | null;
  updatedAt: string | null;
}

export interface ProviderConfig {
  id: number;
  code?: string;
  name?: string;
  provider: string;
  isActive: boolean;
  fromAddress?: string | null;
  fromName?: string | null;
  environment?: string | null;
  lastVerifiedAt?: string | null;
  /** Present only as a boolean - the API never returns credentials. */
  hasCredentials?: boolean;
}

/** `SendStoredEmailResult` - the single shape every outbound path returns. */
export interface SendOutcome {
  outcome: 'SENT' | 'FAILED' | 'SCHEDULED' | 'PENDING_APPROVAL';
  emailId: number;
  mailboxId: number | null;
  providerMessageId: string | null;
  provider: string | null;
  error: string | null;
  classification: string | null;
  recipientCount: number;
  attachmentCount: number;
}

export interface MailEnvelope<T> {
  data?: T;
}

export interface MailListResponse<T> {
  rows: T[];
  pagination: { page: number; pageSize: number; total: number };
}