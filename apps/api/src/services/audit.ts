import pg from 'pg';
import { Ctx } from '../db.js';

export interface AuditEntry {
  action: string;
  resource: string;
  recordId?: number | null;
  recordCode?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/** App-level audit event (business actions; row-level DB changes are audited by triggers). */
export async function logAudit(client: pg.PoolClient | pg.QueryResult, ctx: Ctx, entry: AuditEntry) {
  const c = client as unknown as pg.PoolClient;
  await c.query(
    `INSERT INTO audit_logs
      (tenant_id, company_id, branch_id, user_id, correlation_id, action, resource,
       record_id, record_code, old_values, new_values, changes, ip, user_agent, device, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      ctx.tenantId ?? null,
      ctx.companyId ?? null,
      ctx.branchId ?? null,
      ctx.userId ?? null,
      ctx.correlationId ?? null,
      entry.action,
      entry.resource,
      entry.recordId ?? null,
      entry.recordCode ?? null,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      JSON.stringify({}),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      ctx.device ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ]
  );
}
