import pg from 'pg';

/**
 * Delivery tracking.
 *
 * A provider that only returns a message id has confirmed *acceptance*, not
 * delivery. Anything beyond acceptance must come from a provider webhook or a
 * provider status poll. `confirmed_by_provider` is the flag that records that
 * distinction, and the UI must not claim more than it says.
 */

export type DeliveryEventType =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'OPENED'
  | 'CLICKED'
  | 'BOUNCED'
  | 'FAILED'
  | 'COMPLAINED';

/**
 * Events that can only be asserted by the provider. Recording one of these
 * without provider confirmation would be reporting a fact we do not have.
 */
const PROVIDER_ONLY: ReadonlySet<string> = new Set([
  'DELIVERED',
  'OPENED',
  'CLICKED',
  'BOUNCED',
  'COMPLAINED',
]);

export interface DeliveryEventInput {
  emailId: number;
  recipientId?: number | null;
  eventType: DeliveryEventType;
  provider?: string | null;
  providerMessageId?: string | null;
  occurredAt?: Date | null;
  detail?: Record<string, unknown>;
  /** True only when the provider itself reported this event. */
  confirmedByProvider?: boolean;
}

/**
 * Record a delivery event.
 *
 * Refuses to persist a provider-only event unless it is marked confirmed, so a
 * future caller cannot accidentally manufacture an "Opened" claim from a local
 * assumption. Returns the inserted id, or null when the event was rejected.
 */
export async function recordDeliveryEvent(
  client: pg.PoolClient,
  tenantId: number,
  input: DeliveryEventInput
): Promise<number | null> {
  const eventType = String(input.eventType).toUpperCase();
  const confirmed = input.confirmedByProvider === true;
  if (PROVIDER_ONLY.has(eventType) && !confirmed) {
    return null;
  }
  const { rows } = await client.query(
    `INSERT INTO email_delivery_events
       (tenant_id, email_id, recipient_id, event_type, provider, provider_message_id,
        occurred_at, detail, confirmed_by_provider)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9)
     RETURNING id`,
    [
      tenantId,
      input.emailId,
      input.recipientId ?? null,
      eventType,
      input.provider ?? null,
      input.providerMessageId ?? null,
      input.occurredAt ?? null,
      JSON.stringify(input.detail ?? {}),
      confirmed,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export interface DeliveryEventRow {
  id: number;
  emailId: number;
  recipientId: number | null;
  eventType: string;
  provider: string | null;
  providerMessageId: string | null;
  occurredAt: string;
  detail: Record<string, unknown>;
  confirmedByProvider: boolean;
}

export async function listDeliveryEvents(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number
): Promise<DeliveryEventRow[]> {
  const { rows } = await client.query(
    `SELECT id, email_id, recipient_id, event_type, provider, provider_message_id,
            occurred_at, detail, confirmed_by_provider
       FROM email_delivery_events
      WHERE tenant_id = $1 AND email_id = $2
      ORDER BY occurred_at, id`,
    [tenantId, emailId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    emailId: Number(r.email_id),
    recipientId: r.recipient_id == null ? null : Number(r.recipient_id),
    eventType: String(r.event_type),
    provider: r.provider == null ? null : String(r.provider),
    providerMessageId: r.provider_message_id == null ? null : String(r.provider_message_id),
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    detail: (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>,
    confirmedByProvider: r.confirmed_by_provider === true,
  }));
}

/**
 * The furthest state the provider has actually confirmed for a message.
 * Returns null when nothing has been confirmed beyond local acceptance, so the
 * UI can honestly render "Sent" instead of guessing "Delivered".
 */
export function confirmedStatus(events: readonly DeliveryEventRow[]): string | null {
  const confirmed = events.filter((e) => e.confirmedByProvider);
  if (confirmed.length === 0) return null;
  const rank: Record<string, number> = {
    QUEUED: 1,
    SENT: 2,
    DELIVERED: 3,
    OPENED: 4,
    CLICKED: 5,
  };
  let best: string | null = null;
  let bestRank = 0;
  for (const event of confirmed) {
    if (event.eventType === 'BOUNCED' || event.eventType === 'FAILED' || event.eventType === 'COMPLAINED') {
      return event.eventType;
    }
    const r = rank[event.eventType] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      best = event.eventType;
    }
  }
  return best;
}