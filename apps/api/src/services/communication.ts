import pg from 'pg';
import { Ctx } from '../db.js';

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
  input: NotifyInput
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
                 (SELECT email FROM users WHERE id = $3),
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