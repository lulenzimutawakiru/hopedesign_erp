import pg from 'pg';
import { Ctx, detach } from '../db.js';
import { notifyFromEvent } from './eventNotifications.js';

export interface EventPayload {
  eventType: string;
  entityType?: string | null;
  entityId?: number | null;
  entityCode?: string | null;
  payload?: Record<string, unknown>;
  severity?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
}

/** Central event bus: every business event is persisted to system_events. */
export async function emitEvent(client: pg.PoolClient, ctx: Ctx, e: EventPayload) {
  await client.query(
    `INSERT INTO system_events
      (tenant_id, company_id, branch_id, event_type, entity_type, entity_id, entity_code, user_id, payload, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ctx.tenantId ?? null,
      ctx.companyId ?? null,
      ctx.branchId ?? null,
      e.eventType,
      e.entityType ?? null,
      e.entityId ?? null,
      e.entityCode ?? null,
      ctx.userId ?? null,
      JSON.stringify(e.payload ?? {}),
      e.severity ?? 'INFO',
    ]
  );
  // Fire-and-forget: mirror the event into the instant-notification pipeline on
  // a fresh pooled connection in its own transaction (detach). The caller's
  // client is never shared, so this work cannot run on a connection whose
  // transaction-local context the caller may COMMIT or ROLLBACK, and a failure
  // cannot abort the caller's transaction or poison a pooled connection.
  void detach((dclient, dctx) => notifyFromEvent(dclient, dctx, e), ctx).catch((err) => {
    console.error('[events] notification mirror failed', err instanceof Error ? err.message : err);
  });
}
