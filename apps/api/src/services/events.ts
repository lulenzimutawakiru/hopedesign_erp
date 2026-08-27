import pg from 'pg';
import { Ctx } from '../db.js';

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
}
