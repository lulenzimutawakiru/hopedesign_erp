import pg from 'pg';
import { Ctx, query, tx } from '../db.js';
import { logAudit } from './audit.js';
import { createNotification } from './notifications.js';
import { emitEvent } from './events.js';

/**
 * HOPE DESIGN Service Desk - SLA and escalation engine (spec sections 7 and 17).
 *
 * Two responsibilities:
 *
 *  1. SLA lifecycle. A ticket is measured against the most specific active
 *     policy for its (priority, category, department, ticket_type, branch).
 *     The deadline itself is computed by service_sla_due() in SQL so calendar,
 *     business-hours, weekend and public-holiday handling lives in one place
 *     (packages/db/migrations/0153_service_desk_sla_engine.sql).
 *
 *     CREATED -> response timer -> FIRST RESPONSE -> MET/BREACHED
 *             -> resolution timer -> RESOLVED -> MET/BREACHED
 *
 *  2. Escalation. escalation_rules bind a trigger (NO_RESPONSE,
 *     NO_RESOLUTION, SLA_WARNING, SLA_BREACH) and a delay to an escalation
 *     level (L1 agent .. L5 managing director). Every escalation is written to
 *     ticket_escalations with the actor, the rule and the notified roles.
 *
 * Both run from the same periodic sweep (runServiceDeskSlaTick), which the
 * worker process drives; the API keeps an in-process fallback timer for
 * deployments with no broker.
 */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const str = (v: unknown): string | undefined =>
  v === null || v === undefined || v === '' ? undefined : String(v);

/**
 * Normalise an instant to ISO 8601.
 *
 * Critical: node-postgres returns timestamptz columns as JS Date objects, and
 * String(date) yields the runtime own toString() form -
 * "Mon Sep 14 2026 01:23:10 GMT+0300 (East Africa Time)". Feeding that back as
 * a timestamptz parameter makes Postgres raise
 * `time zone "gmt+0300" not recognized` (SQLSTATE 22023) and aborts the whole
 * ticket transaction. Deadlines computed here are written into sla_tracking,
 * so they must be serialised as ISO 8601 instants, never via String().
 */
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export interface SlaTicketRef {
  id: number;
  companyId: number;
  branchId?: number | null;
  categoryId?: number | null;
  subcategoryId?: number | null;
  priority?: string | null;
  ticketType?: string | null;
  departmentId?: number | null;
  openedAt?: Date | string | null;
}

export interface SlaPolicy {
  id: number;
  code: string;
  name: string;
  responseMinutes: number;
  resolutionMinutes: number;
  calendarId: number | null;
  timeBasis: string;
  pauseOnPending: boolean;
  warningMinutes: number;
  escalationEnabled: boolean;
}

export interface SlaWindow {
  policyId: number;
  responseDueAt: string | null;
  resolutionDueAt: string | null;
  responseWarningAt: string | null;
  resolutionWarningAt: string | null;
}

/**
 * Pick the most specific active policy that covers this ticket.
 *
 * Specificity is weighted so an exact priority always beats a generic
 * catch-all, and within the same priority a category-specific policy beats a
 * company-wide one. Ties break on the lowest policy id, which is stable.
 */
export async function selectSlaPolicy(
  client: pg.PoolClient,
  ctx: Ctx,
  t: SlaTicketRef
): Promise<SlaPolicy | null> {
  const { rows } = await client.query(
    `SELECT p.*,
            (CASE WHEN p.priority      IS NOT NULL THEN 16 ELSE 0 END
           + CASE WHEN p.category_id   IS NOT NULL THEN 8  ELSE 0 END
           + CASE WHEN p.department_id IS NOT NULL THEN 4  ELSE 0 END
           + CASE WHEN p.ticket_type   IS NOT NULL THEN 2  ELSE 0 END
           + CASE WHEN p.branch_id     IS NOT NULL THEN 1  ELSE 0 END) AS specificity
       FROM sla_policies p
      WHERE p.tenant_id = $1
        AND p.company_id = $2
        AND p.is_active
        AND (p.branch_id     IS NULL OR p.branch_id     = $3)
        AND (p.category_id   IS NULL OR p.category_id   = $4)
        AND (p.department_id IS NULL OR p.department_id = $5)
        AND (p.ticket_type   IS NULL OR p.ticket_type   = $6)
        AND (p.priority      IS NULL OR p.priority      = $7)
      ORDER BY specificity DESC, p.priority NULLS LAST, p.id ASC
      LIMIT 1`,
    [
      ctx.tenantId,
      t.companyId,
      t.branchId ?? null,
      t.categoryId ?? null,
      t.departmentId ?? null,
      t.ticketType ?? null,
      t.priority ?? null,
    ]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    responseMinutes: Number(row.response_minutes ?? 0),
    resolutionMinutes: Number(row.resolution_minutes ?? 0),
    calendarId: num(row.calendar_id),
    timeBasis: String(row.time_basis ?? 'CALENDAR'),
    pauseOnPending: row.pause_on_pending !== false,
    warningMinutes: Number(row.warning_minutes ?? 0),
    escalationEnabled: row.escalation_enabled !== false,
  };
}

/** Compute every deadline for a policy from a single reference instant. */
export async function computeSlaWindow(
  client: pg.PoolClient,
  policy: SlaPolicy,
  from: Date
): Promise<SlaWindow> {
  const { rows } = await client.query(
    `SELECT service_sla_due($1,$2,$3,$4)                      AS response_due_at,
            service_sla_due($1,$2,$5,$4)                      AS resolution_due_at,
            service_sla_due($1,$2,GREATEST($3 - $6, 0),$4)    AS response_warning_at,
            service_sla_due($1,$2,GREATEST($5 - $6, 0),$4)    AS resolution_warning_at`,
    [
      policy.timeBasis,
      from.toISOString(),
      policy.responseMinutes,
      policy.calendarId,
      policy.resolutionMinutes,
      policy.warningMinutes,
    ]
  );
  const r = rows[0] ?? {};
  return {
    policyId: policy.id,
    responseDueAt: iso(r.response_due_at),
    resolutionDueAt: iso(r.resolution_due_at),
    responseWarningAt: iso(r.response_warning_at),
    resolutionWarningAt: iso(r.resolution_warning_at),
  };
}

/**
 * Attach (or re-attach) the SLA to a ticket.
 *
 * Called on creation and again whenever priority, category or department
 * change, because each of those selects a different policy. The order of
 * operations matters: the window is written first, then the states are
 * recomputed against whatever response/resolution timestamps already exist, so
 * a re-prioritised ticket keeps an honest history instead of being reset to
 * PENDING.
 */
export async function applySlaToTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  t: SlaTicketRef
): Promise<SlaWindow | null> {
  const policy = await selectSlaPolicy(client, ctx, t);
  if (!policy) return null;
  const from = t.openedAt ? new Date(t.openedAt) : new Date();
  const w = await computeSlaWindow(client, policy, from);

  await client.query(
    `INSERT INTO sla_tracking
       (tenant_id, company_id, branch_id, ticket_id, policy_id, state,
        response_due_at, resolution_due_at, response_warning_at, resolution_warning_at, created_by)
     VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,$9,$10)
     ON CONFLICT (ticket_id) DO UPDATE
        SET policy_id              = EXCLUDED.policy_id,
            state                  = CASE WHEN sla_tracking.state IN ('CANCELLED','MET','BREACHED')
                                          THEN sla_tracking.state ELSE 'RUNNING' END,
            response_due_at        = EXCLUDED.response_due_at,
            resolution_due_at      = EXCLUDED.resolution_due_at,
            response_warning_at    = EXCLUDED.response_warning_at,
            resolution_warning_at  = EXCLUDED.resolution_warning_at,
            response_warning_sent_at = CASE
              WHEN sla_tracking.response_due_at IS DISTINCT FROM EXCLUDED.response_due_at
              THEN NULL ELSE sla_tracking.response_warning_sent_at END,
            resolution_warning_sent_at = CASE
              WHEN sla_tracking.resolution_due_at IS DISTINCT FROM EXCLUDED.resolution_due_at
              THEN NULL ELSE sla_tracking.resolution_warning_sent_at END,
            paused_at              = NULL,
            updated_at             = now()`,
    [
      ctx.tenantId,
      t.companyId,
      t.branchId ?? null,
      t.id,
      policy.id,
      w.responseDueAt,
      w.resolutionDueAt,
      w.responseWarningAt,
      w.resolutionWarningAt,
      ctx.userId ?? null,
    ]
  );

  await client.query(
    `UPDATE service_tickets
        SET sla_response_due_at = $2, sla_resolution_due_at = $3, updated_at = now()
      WHERE id = $1`,
    [t.id, w.responseDueAt, w.resolutionDueAt]
  );

  await recomputeSlaStates(client, t.id);
  return w;
}

/** Re-derive MET/BREACHED from the timestamps actually recorded on the ticket. */
export async function recomputeSlaStates(client: pg.PoolClient, ticketId: number) {
  await client.query(
    `UPDATE sla_tracking
        SET response_state = CASE
              WHEN first_response_at IS NULL OR response_due_at IS NULL THEN 'PENDING'
              WHEN first_response_at <= response_due_at THEN 'MET' ELSE 'BREACHED' END,
            resolution_state = CASE
              WHEN resolved_at IS NULL OR resolution_due_at IS NULL THEN 'PENDING'
              WHEN resolved_at <= resolution_due_at THEN 'MET' ELSE 'BREACHED' END,
            state = CASE
              WHEN state = 'CANCELLED' THEN state
              WHEN resolved_at IS NOT NULL THEN
                CASE WHEN resolved_at <= COALESCE(resolution_due_at, resolved_at) THEN 'MET' ELSE 'BREACHED' END
              WHEN state = 'PAUSED' THEN 'PAUSED'
              WHEN response_due_at IS NOT NULL AND first_response_at IS NULL AND response_due_at < now()
                THEN 'BREACHED'
              WHEN resolution_due_at IS NOT NULL AND resolved_at IS NULL AND resolution_due_at < now()
                THEN 'BREACHED'
              ELSE 'RUNNING' END,
            updated_at = now()
      WHERE ticket_id = $1`,
    [ticketId]
  );
}

/**
 * Record the first public response - the moment the response SLA stops.
 *
 * Only a reply the requester can actually see counts (the caller decides that);
 * an internal work note is not a response to the customer.
 */
export async function recordFirstResponse(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  at: Date = new Date()
) {
  const upd = await client.query(
    `UPDATE sla_tracking
        SET first_response_at = COALESCE(first_response_at, $2), updated_at = now()
      WHERE ticket_id = $1
      RETURNING id, first_response_at, response_due_at, first_response_at > response_due_at AS late`,
    [ticketId, at.toISOString()]
  );
  await client.query(
    `UPDATE service_tickets
        SET first_response_at = COALESCE(first_response_at, $2), updated_at = now()
      WHERE id = $1`,
    [ticketId, at.toISOString()]
  );
  await recomputeSlaStates(client, ticketId);
  const row = upd.rows[0];
  if (row?.late) {
    await recordBreach(client, ctx, {
      ticketId,
      breachType: 'RESPONSE',
      dueAt: row.response_due_at,
      breachedAt: row.first_response_at,
      reason: 'No response before the SLA response target',
    });
  }
}

/** Stop the resolution timer. */
export async function markResolvedForSla(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  at: Date = new Date()
) {
  const upd = await client.query(
    `UPDATE sla_tracking
        SET resolved_at = COALESCE(resolved_at, $2), updated_at = now()
      WHERE ticket_id = $1
      RETURNING id, resolved_at, resolution_due_at, resolved_at > resolution_due_at AS late`,
    [ticketId, at.toISOString()]
  );
  await recomputeSlaStates(client, ticketId);
  const row = upd.rows[0];
  if (row?.late) {
    await recordBreach(client, ctx, {
      ticketId,
      breachType: 'RESOLUTION',
      dueAt: row.resolution_due_at,
      breachedAt: row.resolved_at,
      reason: 'Resolved after the SLA resolution target',
    });
  }
  return row ?? null;
}

/** Pause the clock while the desk is waiting on the requester or a vendor. */
export async function pauseSla(client: pg.PoolClient, ticketId: number, at: Date = new Date()) {
  await client.query(
    `UPDATE sla_tracking
        SET state = 'PAUSED', paused_at = COALESCE(paused_at, $2), updated_at = now()
      WHERE ticket_id = $1 AND state = 'RUNNING'`,
    [ticketId, at.toISOString()]
  );
}

/**
 * Resume the clock and push every deadline out by exactly the paused duration,
 * so a week waiting on a vendor does not silently consume the SLA budget.
 */
export async function resumeSla(client: pg.PoolClient, ticketId: number, at: Date = new Date()) {
  await client.query(
    `UPDATE sla_tracking
        SET paused_minutes       = paused_minutes
                                   + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - paused_at)) / 60))::int,
            response_due_at      = response_due_at      + ($2::timestamptz - paused_at),
            resolution_due_at    = resolution_due_at    + ($2::timestamptz - paused_at),
            response_warning_at  = response_warning_at  + ($2::timestamptz - paused_at),
            resolution_warning_at = resolution_warning_at + ($2::timestamptz - paused_at),
            paused_at            = NULL,
            state                = 'RUNNING',
            updated_at           = now()
      WHERE ticket_id = $1 AND paused_at IS NOT NULL`,
    [ticketId, at.toISOString()]
  );
  await client.query(
    `UPDATE service_tickets
        SET sla_response_due_at   = (SELECT response_due_at   FROM sla_tracking WHERE ticket_id = $1),
            sla_resolution_due_at = (SELECT resolution_due_at FROM sla_tracking WHERE ticket_id = $1),
            updated_at = now()
      WHERE id = $1`,
    [ticketId]
  );
  await recomputeSlaStates(client, ticketId);
}

/** Cancel the SLA entirely (ticket cancelled before it was worked). */
export async function cancelSla(client: pg.PoolClient, ticketId: number) {
  await client.query(
    `UPDATE sla_tracking
        SET state = 'CANCELLED',
            response_state = CASE WHEN response_state = 'PENDING' THEN 'CANCELLED' ELSE response_state END,
            resolution_state = CASE WHEN resolution_state = 'PENDING' THEN 'CANCELLED' ELSE resolution_state END,
            updated_at = now()
      WHERE ticket_id = $1`,
    [ticketId]
  );
}

/** Upsert one breach. (ticket_id, breach_type) is unique, so this is idempotent. */
export async function recordBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  b: { ticketId: number; breachType: 'RESPONSE' | 'RESOLUTION'; dueAt: Date | string | null; breachedAt: Date | string | null; reason?: string }
): Promise<number | null> {
  if (!b.dueAt) return null;
  const breachedAt = b.breachedAt ? new Date(b.breachedAt) : new Date();
  const dueAt = new Date(b.dueAt);
  const minutesOver = Math.max(0, Math.round((breachedAt.getTime() - dueAt.getTime()) / 60_000));
  const { rows } = await client.query(
    `INSERT INTO sla_breaches
       (tenant_id, company_id, branch_id, ticket_id, tracking_id, policy_id,
        breach_type, due_at, breached_at, minutes_over, reason, created_by)
     SELECT t.tenant_id, t.company_id, t.branch_id, t.id, s.id, s.policy_id,
            $2, $3, $4, $5, $6, $7
       FROM service_tickets t
       LEFT JOIN sla_tracking s ON s.ticket_id = t.id
      WHERE t.id = $1
     ON CONFLICT (ticket_id, breach_type) DO NOTHING
     RETURNING id`,
    [b.ticketId, b.breachType, dueAt.toISOString(), breachedAt.toISOString(), minutesOver, b.reason ?? null, ctx.userId ?? null]
  );
  if (rows.length === 0) return null;
  const breachId = Number(rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'service_desk.sla.breached',
    entityType: 'service_desk.tickets',
    entityId: b.ticketId,
    payload: { breachType: b.breachType, dueAt: dueAt.toISOString(), breachedAt: breachedAt.toISOString(), minutesOver },
    severity: b.breachType === 'RESPONSE' ? 'WARN' : 'ERROR',
  });
  await logAudit(client, ctx, {
    action: 'sla_breach',
    resource: 'service_desk.sla',
    recordId: b.ticketId,
    newValues: { breachType: b.breachType, dueAt: dueAt.toISOString(), minutesOver },
  });
  return breachId;
}

/**
 * Role notifications, tenant-scoped.
 *
 * notifications.notifyRole() resolves roles without a tenant predicate, which
 * is fine for interactive requests (the transaction carries app context) but
 * not for the background sweep, which runs for every tenant in turn. This
 * variant pins the recipient set to the tenant being swept.
 */
async function notifyRolesScoped(
  client: pg.PoolClient,
  ctx: Ctx,
  roleCodes: string[],
  n: { type: string; title: string; body?: string; link?: string; entityType?: string; entityId?: number; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; actionRequired?: boolean; data?: Record<string, unknown> }
) {
  if (roleCodes.length === 0) return 0;
  const { rows } = await client.query(
    `SELECT DISTINCT u.id
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       JOIN users u ON u.id = ur.user_id
      WHERE r.code = ANY($1) AND u.status = 'ACTIVE' AND u.tenant_id = $2`,
    [roleCodes, ctx.tenantId]
  );
  for (const row of rows) {
    await createNotification(client, ctx, { ...n, userId: Number(row.id) });
  }
  return rows.length;
}

export interface EscalationOutcome {
  ruleId: number;
  level: number;
  levelCode: string;
  roleCode: string | null;
  notified: number;
}

/**
 * Evaluate every active escalation rule against one ticket and raise the
 * escalations that are due. Idempotent: a rule that already has an open
 * escalation on this ticket is skipped, so the sweep can run every minute
 * without ever double-escalating.
 */
export async function applyEscalationRules(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number
): Promise<EscalationOutcome[]> {
  const tRes = await client.query(
    `SELECT t.id, t.branch_id, t.ticket_number, t.subject, t.priority, t.category_id, t.status,
            t.opened_at, t.first_response_at, t.resolved_at,
            t.assigned_to_user_id, t.assigned_queue_id,
            s.response_due_at, s.resolution_due_at, s.response_state, s.resolution_state,
            EXISTS (SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id AND b.breach_type = 'RESPONSE')   AS response_breached,
            EXISTS (SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id AND b.breach_type = 'RESOLUTION') AS resolution_breached
       FROM service_tickets t
       LEFT JOIN sla_tracking s ON s.ticket_id = t.id
      WHERE t.id = $1`,
    [ticketId]
  );
  const ticket = tRes.rows[0];
  if (!ticket) return [];
  if (['CLOSED', 'CANCELLED'].includes(String(ticket.status))) return [];

  const rRes = await client.query(
    `SELECT r.id, r.code, r.name, r.after_minutes, r.trigger_on, r.notify_roles,
            l.id AS level_id, l.level, l.code AS level_code, l.role_code
       FROM escalation_rules r
       JOIN escalation_levels l ON l.id = r.level_id
      WHERE r.tenant_id = $1 AND r.company_id = $2
        AND r.is_active AND l.is_active
        AND (r.category_id IS NULL OR r.category_id = $3)
        AND (r.priority    IS NULL OR r.priority    = $4)
        AND NOT EXISTS (
          SELECT 1 FROM ticket_escalations e
           WHERE e.ticket_id = $5 AND e.rule_id = r.id AND e.resolved_at IS NULL)
      ORDER BY r.after_minutes ASC, l.level ASC`,
    [ctx.tenantId, ctx.companyId, ticket.category_id ?? null, ticket.priority ?? null, ticketId]
  );

  const openedAt = ticket.opened_at ? new Date(ticket.opened_at).getTime() : Date.now();
  const now = Date.now();
  const outcomes: EscalationOutcome[] = [];

  for (const rule of rRes.rows) {
    const delayMs = Number(rule.after_minutes ?? 0) * 60_000;
    const elapsed = now - openedAt;
    const trigger = String(rule.trigger_on);
    const unresolved = !ticket.resolved_at;
    let due = false;
    if (trigger === 'NO_RESPONSE') {
      due = !ticket.first_response_at && elapsed >= delayMs && unresolved;
    } else if (trigger === 'NO_RESOLUTION') {
      due = unresolved && elapsed >= delayMs;
    } else if (trigger === 'SLA_WARNING') {
      const d = ticket.response_due_at ?? ticket.resolution_due_at;
      due = unresolved && !!d && now >= new Date(d).getTime() - Math.max(delayMs, 0) && now < new Date(d).getTime();
    } else if (trigger === 'SLA_BREACH') {
      due = unresolved && (ticket.response_breached === true || ticket.resolution_breached === true);
    }
    if (!due) continue;

    const roleCode = str(rule.role_code) ?? null;
    const notifyRoles = Array.isArray(rule.notify_roles)
      ? rule.notify_roles.map(String).filter(Boolean)
      : roleCode ? [roleCode] : [];
    const reason = `Automatic escalation (${rule.code}) - ${trigger.replace(/_/g, ' ').toLowerCase()} after ${rule.after_minutes} minutes`;

    const ins = await client.query(
      `INSERT INTO ticket_escalations
         (tenant_id, company_id, branch_id, ticket_id, rule_id, level_id, level, reason,
          trigger_type, escalated_from_user_id, escalated_to_role, notified_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AUTOMATIC',$9,$10,now(),$11)
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.companyId,
        ticket.branch_id ?? null,
        ticketId,
        rule.id,
        rule.level_id,
        Number(rule.level),
        reason,
        ticket.assigned_to_user_id ?? null,
        roleCode,
        ctx.userId ?? null,
      ]
    );
    const escalationId = Number(ins.rows[0].id);

    const notified = await notifyRolesScoped(client, ctx, notifyRoles, {
      type: 'service_desk.ticket.escalated',
      title: `Escalated to L${rule.level}: ${ticket.ticket_number}`,
      body: `${ticket.subject}\n${reason}`,
      link: `/service-desk/tickets/${ticketId}`,
      entityType: 'service_desk.tickets',
      entityId: ticketId,
      severity: Number(rule.level) >= 4 ? 'ERROR' : 'WARN',
      actionRequired: true,
      data: { escalationId, level: Number(rule.level), rule: rule.code, trigger },
    });

    // Escalation also changes the ticket's own status so the queue reflects it.
    // The lifecycle guard only permits the ESCALATED edge from unresolved
    // states, so the update is filtered rather than forced.
    await client.query(
      `UPDATE service_tickets
          SET status = 'ESCALATED', status_reason = $2, updated_at = now()
        WHERE id = $1
          AND status IN ('NEW','OPEN','ASSIGNED','IN_PROGRESS','PENDING_REQUESTER','PENDING_VENDOR')`,
      [ticketId, `Escalated to L${rule.level}: ${rule.name ?? rule.code}`]
    );

    await emitEvent(client, ctx, {
      eventType: 'service_desk.ticket.escalated',
      entityType: 'service_desk.tickets',
      entityId: ticketId,
      entityCode: String(ticket.ticket_number),
      payload: { escalationId, level: Number(rule.level), rule: rule.code, trigger, notified },
      severity: Number(rule.level) >= 4 ? 'ERROR' : 'WARN',
    });
    await logAudit(client, ctx, {
      action: 'escalate',
      resource: 'service_desk.tickets',
      recordId: ticketId,
      recordCode: String(ticket.ticket_number),
      newValues: { escalationId, level: Number(rule.level), rule: rule.code, triggerType: 'AUTOMATIC' },
      metadata: { reason, notified },
    });

    outcomes.push({
      ruleId: Number(rule.id),
      level: Number(rule.level),
      levelCode: String(rule.level_code),
      roleCode,
      notified,
    });
  }
  return outcomes;
}

/** Resolve every open escalation on a ticket (called when it is resolved/closed). */
export async function closeOpenEscalations(client: pg.PoolClient, ticketId: number) {
  const res = await client.query(
    `UPDATE ticket_escalations
        SET resolved_at = now(), updated_at = now()
      WHERE ticket_id = $1 AND resolved_at IS NULL
      RETURNING id`,
    [ticketId]
  );
  return res.rows.length;
}

/** Roles that staff the desk when a ticket has no individual assignee. */
const DESK_ROLE_CODES = ['service_desk_agent', 'service_desk_technician', 'service_desk_manager'];

export interface SlaSweepSummary {
  tenants: number;
  responseWarnings: number;
  resolutionWarnings: number;
  responseBreaches: number;
  resolutionBreaches: number;
  escalations: number;
}

const EMPTY_SWEEP: SlaSweepSummary = {
  tenants: 0,
  responseWarnings: 0,
  resolutionWarnings: 0,
  responseBreaches: 0,
  resolutionBreaches: 0,
  escalations: 0,
};

async function notifyTicketOwnerOrDesk(
  client: pg.PoolClient,
  ctx: Ctx,
  ticket: Record<string, unknown>,
  n: { type: string; title: string; body?: string; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; actionRequired?: boolean; data?: Record<string, unknown> }
): Promise<number> {
  const link = `/service-desk/tickets/${Number(ticket.ticket_id ?? ticket.id)}`;
  const base = {
    ...n,
    link,
    entityType: 'service_desk.tickets',
    entityId: Number(ticket.ticket_id ?? ticket.id),
  };
  const assignee = num(ticket.assigned_to_user_id);
  if (assignee) {
    await createNotification(client, ctx, { ...base, userId: assignee });
    return 1;
  }
  return notifyRolesScoped(client, ctx, DESK_ROLE_CODES, base);
}

/**
 * Sweep one company's tickets: warnings, breaches, then escalation rules.
 * Runs in its own transaction so a single bad ticket cannot abort the pass for
 * the rest of the estate.
 */
async function sweepCompany(tenantId: number, companyId: number): Promise<SlaSweepSummary> {
  return tx(async (client, ctx) => {
    const out: SlaSweepSummary = { ...EMPTY_SWEEP, tenants: 1 };

    const warnings = await client.query(
      `SELECT s.ticket_id, s.response_due_at, s.response_warning_at, s.resolution_due_at, s.resolution_warning_at,
              t.ticket_number, t.subject, t.priority, t.assigned_to_user_id, t.status
         FROM sla_tracking s
         JOIN service_tickets t ON t.id = s.ticket_id
        WHERE s.state IN ('RUNNING','PAUSED')
          AND t.status NOT IN ('RESOLVED','CLOSED','CANCELLED')
          AND ((s.response_state = 'PENDING' AND s.first_response_at IS NULL
                AND s.response_warning_sent_at IS NULL AND s.response_warning_at IS NOT NULL
                AND s.response_warning_at <= now())
            OR (s.resolution_state = 'PENDING' AND s.resolved_at IS NULL
                AND s.resolution_warning_sent_at IS NULL AND s.resolution_warning_at IS NOT NULL
                AND s.resolution_warning_at <= now()))
        ORDER BY LEAST(COALESCE(s.response_warning_at, now()), COALESCE(s.resolution_warning_at, now()))
        LIMIT 200`
    );
    for (const row of warnings.rows) {
      const responseDue = nowOverdue(row.response_warning_at);
      const resolutionDue = nowOverdue(row.resolution_warning_at);
      if (responseDue && row.response_state !== 'MET') {
        await notifyTicketOwnerOrDesk(client, ctx, row, {
          type: 'service_desk.sla.warning',
          title: `SLA response warning: ${row.ticket_number}`,
          body: `${row.subject} - first response due ${iso(row.response_due_at)}`,
          severity: 'WARN',
          actionRequired: true,
          data: { sla: 'RESPONSE', priority: row.priority },
        });
        await client.query(
          `UPDATE sla_tracking SET response_warning_sent_at = now(), updated_at = now()
            WHERE ticket_id = $1 AND response_warning_sent_at IS NULL`,
          [row.ticket_id]
        );
        out.responseWarnings += 1;
      }
      if (resolutionDue) {
        await notifyTicketOwnerOrDesk(client, ctx, row, {
          type: 'service_desk.sla.warning',
          title: `SLA resolution warning: ${row.ticket_number}`,
          body: `${row.subject} - resolution due ${iso(row.resolution_due_at)}`,
          severity: 'WARN',
          actionRequired: true,
          data: { sla: 'RESOLUTION', priority: row.priority },
        });
        await client.query(
          `UPDATE sla_tracking SET resolution_warning_sent_at = now(), updated_at = now()
            WHERE ticket_id = $1 AND resolution_warning_sent_at IS NULL`,
          [row.ticket_id]
        );
        out.resolutionWarnings += 1;
      }
      await recomputeSlaStates(client, Number(row.ticket_id));
    }

    const breaches = await client.query(
      `SELECT s.ticket_id, s.response_due_at, s.resolution_due_at,
              t.ticket_number, t.subject, t.priority, t.assigned_to_user_id
         FROM sla_tracking s
         JOIN service_tickets t ON t.id = s.ticket_id
        WHERE s.state <> 'CANCELLED'
          AND t.status NOT IN ('RESOLVED','CLOSED','CANCELLED')
          AND ((s.response_state = 'PENDING' AND s.first_response_at IS NULL
                AND s.response_due_at IS NOT NULL AND s.response_due_at <= now())
            OR (s.resolution_state = 'PENDING' AND s.resolved_at IS NULL
                AND s.resolution_due_at IS NOT NULL AND s.resolution_due_at <= now()))
        LIMIT 200`
    );
    for (const row of breaches.rows) {
      if (nowOverdue(row.response_due_at)) {
        const id = await recordBreach(client, ctx, {
          ticketId: Number(row.ticket_id),
          breachType: 'RESPONSE',
          dueAt: row.response_due_at,
          breachedAt: new Date(),
          reason: 'First response missed the SLA response target',
        });
        if (id) {
          out.responseBreaches += 1;
          await notifyTicketOwnerOrDesk(client, ctx, row, {
            type: 'service_desk.sla.breach',
            title: `SLA BREACH (response): ${row.ticket_number}`,
            body: `${row.subject} - no first response by ${iso(row.response_due_at)}`,
            severity: 'ERROR',
            actionRequired: true,
            data: { sla: 'RESPONSE', breachId: id, priority: row.priority },
          });
        }
      }
      if (nowOverdue(row.resolution_due_at)) {
        const id = await recordBreach(client, ctx, {
          ticketId: Number(row.ticket_id),
          breachType: 'RESOLUTION',
          dueAt: row.resolution_due_at,
          breachedAt: new Date(),
          reason: 'Resolution missed the SLA resolution target',
        });
        if (id) {
          out.resolutionBreaches += 1;
          await notifyTicketOwnerOrDesk(client, ctx, row, {
            type: 'service_desk.sla.breach',
            title: `SLA BREACH (resolution): ${row.ticket_number}`,
            body: `${row.subject} - not resolved by ${iso(row.resolution_due_at)}`,
            severity: 'ERROR',
            actionRequired: true,
            data: { sla: 'RESOLUTION', breachId: id, priority: row.priority },
          });
        }
      }
      await recomputeSlaStates(client, Number(row.ticket_id));
    }

    const candidates = await client.query(
      `SELECT DISTINCT t.id
         FROM service_tickets t
         JOIN escalation_rules r
           ON r.tenant_id = t.tenant_id AND r.company_id = t.company_id AND r.is_active
          AND (r.category_id IS NULL OR r.category_id = t.category_id)
          AND (r.priority    IS NULL OR r.priority    = t.priority)
         JOIN escalation_levels l ON l.id = r.level_id AND l.is_active
        WHERE t.status NOT IN ('RESOLVED','CLOSED','CANCELLED')
          AND t.opened_at >= now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM ticket_escalations e
             WHERE e.ticket_id = t.id AND e.rule_id = r.id AND e.resolved_at IS NULL)
        ORDER BY t.id
        LIMIT 300`
    );
    for (const row of candidates.rows) {
      const raised = await applyEscalationRules(client, ctx, Number(row.id));
      out.escalations += raised.length;
    }

    return out;
  }, { tenantId, companyId });
}

const nowOverdue = (v: unknown): boolean => {
  const t = iso(v);
  return t !== null && new Date(t).getTime() <= Date.now();
};

let sweepRunning = false;

/**
 * Periodic Service Desk sweep: SLA warnings, SLA breaches and automatic
 * escalation. Driven by the scheduled-task worker; also reachable from the
 * in-process fallback timer and from an admin "run now" endpoint.
 */
export async function runServiceDeskSlaTick(): Promise<SlaSweepSummary> {
  if (sweepRunning) return { ...EMPTY_SWEEP };
  sweepRunning = true;
  try {
    const tenants = await query<{ id: number }>('SELECT id FROM tenants ORDER BY id');
    const total: SlaSweepSummary = { ...EMPTY_SWEEP };
    for (const t of tenants.rows) {
      const tenantId = Number(t.id);
      const companies = await query<{ company_id: number }>(
        'SELECT DISTINCT company_id FROM service_tickets ORDER BY company_id',
        [],
        { tenantId }
      );
      total.tenants += 1;
      for (const c of companies.rows) {
        const summary = await sweepCompany(tenantId, Number(c.company_id));
        total.responseWarnings += summary.responseWarnings;
        total.resolutionWarnings += summary.resolutionWarnings;
        total.responseBreaches += summary.responseBreaches;
        total.resolutionBreaches += summary.resolutionBreaches;
        total.escalations += summary.escalations;
      }
    }
    return total;
  } finally {
    sweepRunning = false;
  }
}
