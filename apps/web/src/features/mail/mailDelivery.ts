import type { DeliveryEvent, MessagePolicy } from './mail.types';

/**
 * The backend only reports a delivery state the provider has actually confirmed
 * (`confirmedDeliveryStatus` is null until a webhook with
 * `confirmedByProvider === true` lands). Absence of an event is *not* a failure,
 * so we render the stored message state and never invent "Delivered"/"Opened".
 */
export const PROVIDER_CONFIRMED_ONLY = new Set([
  'DELIVERED',
  'OPENED',
  'CLICKED',
  'BOUNCED',
  'COMPLAINED',
]);

export type DeliveryTone =
  | 'badge-neutral'
  | 'badge-blue'
  | 'badge-green'
  | 'badge-amber'
  | 'badge-red'
  | 'badge-purple'
  | 'badge-teal';

export interface DeliveryView {
  label: string;
  tone: DeliveryTone;
  /** True when the label came from a provider-confirmed event. */
  confirmed: boolean;
  detail: string;
}

const STORED_LABELS: Record<string, { label: string; tone: DeliveryTone }> = {
  DRAFT: { label: 'Draft', tone: 'badge-neutral' },
  SCHEDULED: { label: 'Scheduled', tone: 'badge-blue' },
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'badge-amber' },
  QUEUED: { label: 'Queued', tone: 'badge-blue' },
  SENDING: { label: 'Sending', tone: 'badge-blue' },
  SENT: { label: 'Sent', tone: 'badge-green' },
  FAILED: { label: 'Send failed', tone: 'badge-red' },
  CANCELLED: { label: 'Cancelled', tone: 'badge-neutral' },
};

/**
 * Render the honest state of a message: the stored lifecycle status, upgraded to
 * a provider-confirmed event only when the backend says one exists.
 */
export function deliveryView(
  storedStatus: unknown,
  confirmedStatus: string | null | undefined,
  events: DeliveryEvent[] = []
): DeliveryView {
  const stored = String(storedStatus ?? '').toUpperCase();
  const confirmed = String(confirmedStatus ?? '').toUpperCase();
  const eventCount = events.length;
  const providerEvents = events.filter((e) => e.confirmedByProvider);

  if (confirmed && PROVIDER_CONFIRMED_ONLY.has(confirmed)) {
    const tone: DeliveryTone =
      confirmed === 'BOUNCED' || confirmed === 'COMPLAINED'
        ? 'badge-red'
        : confirmed === 'DELIVERED'
          ? 'badge-green'
          : 'badge-blue';
    return {
      label: confirmed.charAt(0) + confirmed.slice(1).toLowerCase(),
      tone,
      confirmed: true,
      detail: providerEvents.length
        ? `${providerEvents.length} provider-confirmed event(s)`
        : 'Confirmed by the mail provider',
    };
  }

  const base = STORED_LABELS[stored] ?? { label: stored || 'Unknown', tone: 'badge-neutral' as DeliveryTone };
  return {
    label: base.label,
    tone: base.tone,
    confirmed: false,
    detail:
      stored === 'SENT'
        ? eventCount
          ? 'Accepted by the mail provider; delivery not yet confirmed.'
          : 'Accepted by the mail provider. No delivery confirmation received.'
        : eventCount
          ? `${eventCount} delivery event(s) recorded`
          : 'No delivery events recorded',
  };
}

/** Delivery/outbox rows carry their own status column; normalise the label. */
export function outboxStatusView(status: unknown): DeliveryView {
  const key = String(status ?? '').toUpperCase();
  const base = STORED_LABELS[key] ?? { label: key.replace(/_/g, ' ') || '—', tone: 'badge-neutral' as DeliveryTone };
  return { label: base.label, tone: base.tone, confirmed: false, detail: '' };
}

/**
 * `policy.{forward,download,print,export}` is null when the action is allowed,
 * and holds the *reason* it is blocked otherwise. Never treat the non-null value
 * as a boolean.
 */
export type PolicyAction = keyof MessagePolicy;

export const POLICY_LABELS: Record<PolicyAction, string> = {
  forward: 'Forward',
  download: 'Download attachments',
  print: 'Print',
  export: 'Export',
};

export function policyReason(policy: MessagePolicy | null | undefined, action: PolicyAction): string {
  if (!policy) return '';
  const raw = policy[action];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

export function policyAllows(policy: MessagePolicy | null | undefined, action: PolicyAction): boolean {
  return policyReason(policy, action) === '';
}

export function policyBlocked(policy: MessagePolicy | null | undefined): Array<{ action: PolicyAction; reason: string }> {
  if (!policy) return [];
  return (Object.keys(POLICY_LABELS) as PolicyAction[])
    .map((action) => ({ action, reason: policyReason(policy, action) }))
    .filter((row) => row.reason !== '');
}

/** Classification levels carry a risk tone so the badge reads at a glance. */
export function classificationTone(level: number | string | null | undefined): DeliveryTone {
  const n = Number(level);
  if (!Number.isFinite(n)) return 'badge-neutral';
  if (n >= 5) return 'badge-red';
  if (n === 4) return 'badge-amber';
  if (n === 3) return 'badge-purple';
  if (n === 2) return 'badge-blue';
  return 'badge-neutral';
}

/** Approval block reasons are backend-computed; show them verbatim to the user. */
export const BLOCK_REASON_TEXT: Record<string, string> = {
  SELF_APPROVAL_FORBIDDEN:
    'You raised this request. Segregation-of-duties rules require another authorised approver to decide it.',
  EARLIER_STEP_PENDING: 'An earlier approval step is still pending. This step cannot be decided yet.',
  ALREADY_DECIDED_EARLIER_STEP:
    'An earlier step has already been decided. Reload the request to see the current state.',
};

export function blockReasonText(reason: string | null | undefined): string {
  const key = String(reason ?? '');
  return BLOCK_REASON_TEXT[key] ?? (key ? key.replace(/_/g, ' ').toLowerCase() : '');
}

/**
 * The backend refuses to report DELIVERED/OPENED/etc. without a confirmed event
 * and answers 403 when a policy forbids the action, so the UI disables the
 * control and surfaces the reason rather than offering a doomed button.
 */
export function attachmentDownloadBlocked(
  policy: MessagePolicy | null | undefined,
  attachment: { scanStatus?: string | null }
): string {
  const scan = String(attachment.scanStatus ?? '').toUpperCase();
  if (scan === 'INFECTED' || scan === 'BLOCKED') {
    return 'This attachment failed the malware scan and cannot be downloaded.';
  }
  return policyReason(policy, 'download');
}