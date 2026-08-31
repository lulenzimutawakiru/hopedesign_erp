import pg from 'pg';
import { Ctx, query } from '../db.js';
import { dispatchBird } from './bird.js';

export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL';
export type NotificationSeverity = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export interface NotifyInput {
  userIds?: number[];
  roleCodes?: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: number;
  priority?: NotificationPriority;
  severity?: NotificationSeverity;
  actionLabel?: string;
  actionTarget?: string;
  data?: Record<string, unknown>;
  channels?: string[];
}

/** Resolve recipient user ids from explicit ids and/or role codes within the tenant. */
export async function resolveRecipients(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Pick<NotifyInput, 'userIds' | 'roleCodes'>
): Promise<number[]> {
  const tenantId = ctx.tenantId ?? 0;
  const ids = new Set<number>((input.userIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const roleCodes = (input.roleCodes ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  if (roleCodes.length > 0) {
    const { rows } = await client.query(
      `SELECT DISTINCT ur.user_id AS id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE r.tenant_id = $1 AND r.code = ANY($2::text[])
          AND (ur.company_id IS NULL OR ur.company_id = $3)`,
      [tenantId, roleCodes, ctx.companyId ?? null]
    );
    for (const row of rows) ids.add(Number(row.id));
  }
  return [...ids];
}

/** Create notifications (and per-channel deliveries) for a set of users. */
export async function notifyUsers(
  client: pg.PoolClient,
  ctx: Ctx,
  input: NotifyInput,
  userIds: number[]
): Promise<number[]> {
  const tenantId = ctx.tenantId ?? 0;
  const companyId = ctx.companyId ?? null;
  const channels = input.channels?.length ? input.channels : ['IN_APP'];
  const created: number[] = [];
  for (const uid of userIds) {
    const { rows } = await client.query(
      `INSERT INTO notifications
         (company_id, tenant_id, user_id, type, title, body, link, entity_type, entity_id,
          severity, action_required, priority, channel, action_label, action_target, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        companyId,
        tenantId,
        uid,
        input.type,
        input.title,
        input.body ?? null,
        input.link ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.severity ?? 'INFO',
        input.actionLabel != null,
        input.priority ?? 'NORMAL',
        channels[0] ?? 'IN_APP',
        input.actionLabel ?? null,
        input.actionTarget ?? null,
        JSON.stringify(input.data ?? {}),
      ]
    );
    const notificationId = Number(rows[0].id);
    created.push(notificationId);
    for (const ch of channels) {
      await client.query(
        `INSERT INTO notification_deliveries
           (tenant_id, notification_id, user_id, channel, recipient, status, provider, sent_at)
         VALUES ($1,$2,$3,$4,
                 CASE WHEN $4 IN ('SMS','WHATSAPP') THEN (SELECT phone FROM users WHERE id = $3)
                      ELSE (SELECT email FROM users WHERE id = $3) END,
                 CASE WHEN $4 = 'IN_APP' THEN 'DELIVERED' ELSE 'QUEUED' END,
                 $5, now())
         ON CONFLICT DO NOTHING`,
        [tenantId, notificationId, uid, ch, ch.toLowerCase()]
      );
    }
  }
  return created;
}

/** Append an event to the communication event stream. */
export async function recordEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  eventType: string,
  payload: Record<string, unknown>,
  entityType?: string,
  entityId?: number
): Promise<void> {
  await client.query(
    `INSERT INTO communication_events (tenant_id, company_id, entity_type, entity_id, actor_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      ctx.tenantId ?? 0,
      ctx.companyId ?? null,
      entityType ?? null,
      entityId ?? null,
      ctx.userId ?? null,
      eventType,
      JSON.stringify(payload),
    ]
  );
}

/** Audit a communication action (comms-specific audit trail). */
export async function auditComms(
  client: pg.PoolClient,
  ctx: Ctx,
  action: string,
  targetType: string,
  targetId: number | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO communication_audit_logs
       (tenant_id, company_id, user_id, action, target_type, target_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ctx.tenantId ?? 0,
      ctx.companyId ?? null,
      ctx.userId ?? null,
      action,
      targetType,
      targetId,
      JSON.stringify(detail),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
    ]
  );
}

/** Render {{VAR}} placeholders in a template subject/body. */
export function renderTemplate(
  subject: string,
  body: string,
  variables: Record<string, unknown>
): { subject: string; body: string } {
  const fill = (s: string): string =>
    s.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string) => {
      const v = variables[key];
      return v == null ? `{{${key}}}` : String(v);
    });
  return { subject: fill(subject), body: fill(body) };
}
// ---------------------------------------------------------------------------
// Delivery dispatcher (Bird email / SMS / WhatsApp)
// ---------------------------------------------------------------------------

const RETRY_DELAYS_SECONDS = [30, 120, 600];
const MAX_DELIVERY_RETRIES = 3;

let deliveryLoopRunning = false;

/**
 * Dispatch queued EMAIL/SMS/WHATSAPP deliveries through the Bird provider.
 * Called on an interval from the API server (single-flight). On failure the
 * delivery is retried with an exponential backoff, then marked FAILED.
 */
export async function processNotificationDeliveries(): Promise<{ processed: number; ok: number; failed: number }> {
  if (deliveryLoopRunning) return { processed: 0, ok: 0, failed: 0 };
  deliveryLoopRunning = true;
  try {
    const res = await query(
      `SELECT d.id, d.user_id, d.channel, d.recipient, d.retry_count,
              n.title, n.body, u.email, u.phone
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
         JOIN users u ON u.id = d.user_id
        WHERE d.channel IN ('EMAIL','SMS','WHATSAPP')
          AND d.status IN ('QUEUED','RETRYING')
          AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
        ORDER BY d.created_at ASC
        LIMIT 100`
    );
    let ok = 0;
    let failed = 0;
    for (const row of res.rows as Record<string, unknown>[]) {
      const deliveryId = Number(row.id);
      const channel = String(row.channel);
      const recipient = String(row.recipient ?? '').trim();
      const email = String(row.email ?? '').trim();
      const phone = String(row.phone ?? '').trim();
      const to = channel === 'EMAIL' ? recipient || email : recipient || phone;
      const result = await dispatchBird(channel, to, {
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
      });
      if (result.ok) {
        await query(
          `UPDATE notification_deliveries
              SET status = 'SENT', provider = 'bird', provider_message_id = $1, sent_at = now(), error = NULL
            WHERE id = $2`,
          [result.providerMessageId ?? null, deliveryId]
        );
        ok += 1;
      } else {
        const attempts = Number(row.retry_count ?? 0) + 1;
        if (attempts <= MAX_DELIVERY_RETRIES) {
          const delaySeconds =
            RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
          await query(
            `UPDATE notification_deliveries
                SET status = 'RETRYING', retry_count = $1, error = $2,
                    next_retry_at = now() + ($3::int || ' seconds')::interval
              WHERE id = $4`,
            [attempts, result.error ?? 'unknown', delaySeconds, deliveryId]
          );
        } else {
          await query(
            `UPDATE notification_deliveries
                SET status = 'FAILED', retry_count = $1, error = $2
              WHERE id = $3`,
            [attempts, result.error ?? 'unknown', deliveryId]
          );
        }
        failed += 1;
      }
    }
    return { processed: res.rows.length, ok, failed };
  } finally {
    deliveryLoopRunning = false;
  }
}
