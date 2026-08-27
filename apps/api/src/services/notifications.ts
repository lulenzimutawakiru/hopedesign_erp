import pg from 'pg';
import { Ctx } from '../db.js';

export interface NotificationInput {
  userId: number;
  type: string;
  title: string;
  body?: string;
  link?: string;
  entityType?: string | null;
  entityId?: number | null;
  severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  actionRequired?: boolean;
  data?: Record<string, unknown>;
}

export async function createNotification(client: pg.PoolClient, ctx: Ctx, n: NotificationInput) {
  await client.query(
    `INSERT INTO notifications
      (company_id, tenant_id, user_id, type, title, body, link, entity_type, entity_id, severity, action_required, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      n.userId,
      n.type,
      n.title,
      n.body ?? null,
      n.link ?? null,
      n.entityType ?? null,
      n.entityId ?? null,
      n.severity ?? 'INFO',
      n.actionRequired ?? false,
      JSON.stringify(n.data ?? {}),
    ]
  );
}

/** Notify every user holding one of the given role codes. */
export async function notifyRole(
  client: pg.PoolClient,
  ctx: Ctx,
  roleCodes: string[],
  n: Omit<NotificationInput, 'userId'>
) {
  const res = await client.query(
    `SELECT DISTINCT u.id FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = ur.user_id
     WHERE r.code = ANY($1) AND u.status = 'ACTIVE'`,
    [roleCodes]
  );
  for (const row of res.rows) {
    await createNotification(client, ctx, { ...n, userId: Number(row.id) });
  }
}
