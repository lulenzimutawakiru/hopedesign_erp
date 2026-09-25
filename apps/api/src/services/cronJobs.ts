import pg from 'pg';
import { Ctx, query, tx } from '../db.js';
import { logAudit } from './audit.js';
import { insertOutboundEmail, notifyUsers, resolveRecipients } from './communication.js';
import { loadAuthUser } from '../middleware/auth.js';
import { sendStoredEmail } from './mail/send.js';
import { computeNextRun } from './reportScheduler.js';
import { loadCompanyProfile, reportFingerprint } from './branding.js';
import { renderTablePdf, type BrandedTableColumn } from './brandedExport.js';
import { governanceSweep } from './governance.js';
import { ApiError } from '../utils.js';

export interface CronJobRow {
  id: number;
  tenantId: number;
  companyId: number | null;
  branchId: number | null;
  code: string;
  name: string;
  jobType: string;
  scheduleType: string;
  runTime: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  intervalMinutes: number | null;
  params: Record<string, unknown>;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function toCronJobRow(row: Record<string, unknown>): CronJobRow {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    companyId: row.company_id === null || row.company_id === undefined ? null : Number(row.company_id),
    branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    jobType: String(row.job_type ?? ''),
    scheduleType: String(row.schedule_type ?? 'DAILY'),
    runTime: String(row.run_time ?? '08:00').slice(0, 5),
    dayOfWeek: row.day_of_week === null || row.day_of_week === undefined ? null : Number(row.day_of_week),
    dayOfMonth: row.day_of_month === null || row.day_of_month === undefined ? null : Number(row.day_of_month),
    intervalMinutes: row.interval_minutes === null || row.interval_minutes === undefined ? null : Number(row.interval_minutes),
    params: (row.params ?? {}) as Record<string, unknown>,
    timezone: String(row.timezone ?? 'Africa/Kampala'),
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : String(row.next_run_at),
    lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
  };
}

function rolesOf(job: CronJobRow): string[] {
  const raw = job.params?.notifyRoles ?? job.params?.notify_roles;
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

function numParam(job: CronJobRow, key: string, fallback: number): number {
  const v = job.params?.[key];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Channels for the scheduled nags below (stale work orders, expiring
 * documents, pending QC, aged quarantine, dead stock, unpaid payments).
 *
 * Every one of these checks notifies once per matching record and re-runs on
 * its own schedule, so together they were the dominant source of outbound
 * mail: on 2026-09-22 the stale-work-order check alone produced ~39 copies of
 * each "... has no recent activity" subject in a single day.
 *
 * That volume matters because Resend's daily quota is shared with the sign-in
 * codes and password mail. On 2026-09-20/21 the quota ran out and 41 alert
 * messages died with `429 daily_quota_exceeded` - a sign-in code issued in
 * that same window would have died identically.
 *
 * These items are review work rather than security events, so they reach the
 * right people through the in-app bell and stay out of the inbox. Security
 * mail keeps EMAIL: `system.password_expiry` below still emails, because a
 * user who must change their password has to be told in their inbox.
 */
const NAG_CHANNELS: string[] = ['IN_APP'];

/**
 * Next fire time for one job.
 *
 * TIME CONTRACT: `runTime` is read against the server clock, and every
 * application container runs in UTC (see 0186_attendance_summary_email.sql).
 * The `cron_jobs.timezone` column records the zone the schedule is *presented*
 * in; the admin API converts to and from it at that boundary
 * (routes/adminCron.ts) so what is stored here stays on the server clock. Do
 * not apply the timezone column inside this function: doing so would move every
 * existing job by its UTC offset on the day it ships.
 */
function nextRunFor(job: CronJobRow, from: Date): Date {
  if (job.scheduleType === 'INTERVAL' && job.intervalMinutes && job.intervalMinutes > 0) {
    return new Date(from.getTime() + job.intervalMinutes * 60_000);
  }
  if (job.scheduleType === 'ONCE') {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  return computeNextRun(job.scheduleType, job.runTime || '08:00', job.dayOfWeek, job.dayOfMonth, from);
}

/**
 * Exported for the admin route: a schedule edit recomputes next_run_at with
 * exactly the logic the runner uses, rather than a second implementation that
 * could quietly drift from it.
 */
export function nextRunAtFor(job: CronJobRow, from: Date = new Date()): Date {
  return nextRunFor(job, from);
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function stockReorderCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `SELECT p.id, p.code, p.name, p.reorder_point, p.safety_stock,
           COALESCE(SUM(i.quantity - i.reserved_qty), 0)::numeric AS available_qty
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1
       AND p.status IN ('ACTIVE','INACTIVE')
       AND p.type IN ('JUMBO_ROLL','PAPER_BOBBIN','PACKAGING','CONSUMABLE','SPARE_PART')
       AND p.reorder_point > 0
     GROUP BY p.id
    HAVING COALESCE(SUM(i.quantity - i.reserved_qty), 0) <= p.reorder_point
     ORDER BY available_qty ASC
     LIMIT 50`,
    [ctx.tenantId]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  let alerts = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const code = String(r.code);
    const name = String(r.name);
    const available = Number(r.available_qty);
    const reorder = Number(r.reorder_point);
    const safety = Number(r.safety_stock ?? 0);
    const critical = available <= safety;
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'inventory.low_stock',
        title: critical ? `Critical low stock: ${name}` : `Low stock: ${name}`,
        body: `${name} (${code}) has ${available} available vs reorder point ${reorder} (safety stock ${safety}).`,
        link: `/inventory/items/${id}`,
        entityType: 'product',
        entityId: id,
        priority: critical ? 'URGENT' : 'HIGH',
        severity: critical ? 'ERROR' : 'WARN',
        actionLabel: 'Review Stock',
        actionTarget: `/inventory/items/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, itemCode: code, available, reorderPoint: reorder, safetyStock: safety, critical },
      },
      userIds
    );
    notified += userIds.length;
    if (critical && ctx.companyId) {
      await client.query(
        `INSERT INTO production_alerts (company_id, tenant_id, alert_type, severity, title, message, ref_type, ref_id, payload)
         VALUES ($1,$2,'MATERIAL_RUNNING_LOW','WARNING',$3,$4,'product',$5,$6::jsonb)`,
        [
          ctx.companyId,
          ctx.tenantId,
          `Material running low: ${name}`,
          `${name} (${code}) available ${available} is at or below safety stock ${safety}.`,
          id,
          JSON.stringify({ itemCode: code, available, safetyStock: safety }),
        ]
      );
      alerts += 1;
    }
  }
  return { checked: rows.length, reorderItems: rows.length, notified, alerts };
}

async function contractExpiryCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const windowDays = numParam(job, 'window_days', 30);
  const { rows } = await client.query(
    `SELECT ec.id, ec.employee_id, ec.contract_type, ec.end_date,
           e.employee_no, e.first_name, e.last_name
      FROM employment_contracts ec
      JOIN employees e ON e.id = ec.employee_id
     WHERE e.tenant_id = $1
       AND ec.status = 'ACTIVE'
       AND ec.end_date IS NOT NULL
       AND ec.end_date <= (CURRENT_DATE + $2::int)
     ORDER BY ec.end_date ASC
     LIMIT 100`,
    [ctx.tenantId, windowDays]
  );
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const employeeId = Number(r.employee_id);
    const fullName = `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() || String(r.employee_no ?? id);
    const daysLeft = Math.max(0, Math.ceil((new Date(String(r.end_date)).getTime() - Date.now()) / 86_400_000));
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'hr.contract_expiry',
        title: `Contract expiring: ${fullName}`,
        body: `${fullName}'s ${String(r.contract_type ?? '')} contract expires on ${String(r.end_date)} (${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining).`,
        link: `/hr/employees/${employeeId}?tab=contracts`,
        entityType: 'employment_contract',
        entityId: id,
        priority: daysLeft <= 14 ? 'URGENT' : 'HIGH',
        severity: daysLeft <= 14 ? 'ERROR' : 'WARN',
        actionLabel: 'View Contract',
        actionTarget: `/hr/employees/${employeeId}?tab=contracts`,
        channels: NAG_CHANNELS,
        data: { job: job.code, employeeId, employeeNo: String(r.employee_no), endDate: String(r.end_date), daysLeft },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { windowDays, expiringContracts: rows.length, notified };
}

async function assetMaintenanceCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const windowDays = numParam(job, 'window_days', 14);
  const { rows } = await client.query(
    `SELECT id, asset_no, name, next_maintenance, maintenance_status
      FROM asset_register
     WHERE tenant_id = $1
       AND is_deleted = false
       AND next_maintenance IS NOT NULL
       AND next_maintenance <= (CURRENT_DATE + $2::int)
       AND maintenance_status IN ('NONE','NONE_DUE','DUE')
     ORDER BY next_maintenance ASC
     LIMIT 100`,
    [ctx.tenantId, windowDays]
  );
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  let alerts = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const assetNo = String(r.asset_no);
    const name = String(r.name);
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'asset.maintenance_due',
        title: `Maintenance due: ${name}`,
        body: `${name} (${assetNo}) has maintenance due on ${String(r.next_maintenance)}.`,
        link: `/assets/${id}`,
        entityType: 'asset_register',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Schedule Maintenance',
        actionTarget: `/assets/${id}?tab=maintenance`,
        channels: NAG_CHANNELS,
        data: { job: job.code, assetNo, dueDate: String(r.next_maintenance) },
      },
      userIds
    );
    notified += userIds.length;
    if (ctx.companyId) {
      await client.query(
        `INSERT INTO production_alerts (company_id, tenant_id, alert_type, severity, title, message, ref_type, ref_id, payload)
         VALUES ($1,$2,'MAINTENANCE_DUE','WARNING',$3,$4,'asset_register',$5,$6::jsonb)`,
        [
          ctx.companyId,
          ctx.tenantId,
          `Maintenance due: ${name}`,
          `${name} (${assetNo}) maintenance due ${String(r.next_maintenance)}.`,
          id,
          JSON.stringify({ assetNo }),
        ]
      );
      alerts += 1;
    }
  }
  return { windowDays, assetsDue: rows.length, notified, alerts };
}

async function assetInspectionCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const windowDays = numParam(job, 'window_days', 14);
  const { rows } = await client.query(
    `SELECT id, asset_no, name, next_inspection
      FROM asset_register
     WHERE tenant_id = $1
       AND is_deleted = false
       AND next_inspection IS NOT NULL
       AND next_inspection <= (CURRENT_DATE + $2::int)
     ORDER BY next_inspection ASC
     LIMIT 100`,
    [ctx.tenantId, windowDays]
  );
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const assetNo = String(r.asset_no);
    const name = String(r.name);
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'asset.inspection_due',
        title: `Inspection due: ${name}`,
        body: `${name} (${assetNo}) has an inspection due on ${String(r.next_inspection)}.`,
        link: `/assets/${id}`,
        entityType: 'asset_register',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Schedule Inspection',
        actionTarget: `/assets/${id}?tab=maintenance`,
        channels: NAG_CHANNELS,
        data: { job: job.code, assetNo, dueDate: String(r.next_inspection) },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { windowDays, assetsDue: rows.length, notified };
}

async function custodyOverdueCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `UPDATE asset_register
        SET custody_status = 'OVERDUE', updated_at = now()
      WHERE tenant_id = $1
        AND is_deleted = false
        AND custody_status = 'ASSIGNED'
        AND expected_return_date IS NOT NULL
        AND expected_return_date < CURRENT_DATE
    RETURNING id, asset_no, name, custodian_user_id, expected_return_date`,
    [ctx.tenantId]
  );
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const assetNo = String(r.asset_no);
    const name = String(r.name);
    const custodianId = r.custodian_user_id === null || r.custodian_user_id === undefined ? null : Number(r.custodian_user_id);
    const targets = custodianId ? [...userIds, custodianId] : userIds;
    await notifyUsers(
      client,
      ctx,
      {
        userIds: targets,
        type: 'asset.custody_overdue',
        title: `Custody overdue: ${name}`,
        body: `${name} (${assetNo}) was expected back on ${String(r.expected_return_date)} and is now overdue.`,
        link: `/assets/${id}`,
        entityType: 'asset_register',
        entityId: id,
        priority: 'URGENT',
        severity: 'ERROR',
        actionLabel: 'Review Custody',
        actionTarget: `/assets/${id}?tab=custody`,
        channels: NAG_CHANNELS,
        data: { job: job.code, assetNo, expectedReturnDate: String(r.expected_return_date) },
      },
      targets
    );
    notified += targets.length;
  }
  return { assetsOverdue: rows.length, notified };
}

async function workOrderOverdueCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `SELECT wo.id, wo.wo_no, wo.due_date, wo.status, wo.priority,
           p.code AS product_code, p.name AS product_name
      FROM work_orders wo
      JOIN products p ON p.id = wo.product_id
     WHERE wo.tenant_id = $1
       AND wo.status IN ('APPROVED','RELEASED','IN_PROGRESS')
       AND wo.due_date IS NOT NULL
       AND wo.due_date < CURRENT_DATE
     ORDER BY wo.due_date ASC
     LIMIT 100`,
    [ctx.tenantId]
  );
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  let alerts = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const woNo = String(r.wo_no);
    const productName = String(r.product_name ?? r.product_code ?? '');
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'production.work_order_overdue',
        title: `Work order overdue: ${woNo}`,
        body: `Work order ${woNo} for ${productName} was due on ${String(r.due_date)} and is now overdue.`,
        link: `/production/work-orders/${id}`,
        entityType: 'work_order',
        entityId: id,
        priority: 'URGENT',
        severity: 'ERROR',
        actionLabel: 'Review Work Order',
        actionTarget: `/production/work-orders/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, workOrderNo: woNo, dueDate: String(r.due_date), status: String(r.status) },
      },
      userIds
    );
    notified += userIds.length;
    if (ctx.companyId) {
      await client.query(
        `INSERT INTO production_alerts (company_id, tenant_id, alert_type, severity, title, message, ref_type, ref_id, payload)
         VALUES ($1,$2,'ORDER_DEADLINE','WARNING',$3,$4,'work_order',$5,$6::jsonb)`,
        [
          ctx.companyId,
          ctx.tenantId,
          `Work order overdue: ${woNo}`,
          `${woNo} for ${productName} was due on ${String(r.due_date)}.`,
          id,
          JSON.stringify({ workOrderNo: woNo, dueDate: String(r.due_date) }),
        ]
      );
      alerts += 1;
    }
  }
  return { overdueOrders: rows.length, notified, alerts };
}

async function approvalEscalation(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const graceHours = numParam(job, 'grace_hours', 24);
  const { rows } = await client.query(
    `SELECT t.id, t.instance_id, t.step_name, wi.entity_type, wi.entity_code,
           wi.entity_id, wi.created_by
      FROM approval_tasks t
      JOIN workflow_instances wi ON wi.id = t.instance_id AND wi.tenant_id = $1
     WHERE t.status = 'PENDING'
       AND t.created_at < (now() - ($2::int || ' hours')::interval)
     ORDER BY t.created_at ASC
     LIMIT 100`,
    [ctx.tenantId, graceHours]
  );
  const ids = (rows as Record<string, unknown>[]).map((r) => Number(r.id));
  const instanceIds = [...new Set((rows as Record<string, unknown>[]).map((r) => Number(r.instance_id)))];
  let escalated = 0;
  if (ids.length > 0) {
    const up = await client.query(
      `UPDATE approval_tasks SET status = 'ESCALATED', comment = COALESCE(comment, '') || ' [auto-escalated by ' || $2 || ']'
        WHERE id = ANY($1::bigint[]) AND status = 'PENDING'`,
      [ids, job.code]
    );
    escalated = up.rowCount ?? 0;
    if (instanceIds.length > 0) {
      await client.query(
        `UPDATE workflow_instances wi
            SET status = 'ESCALATED', completed_at = now()
           FROM approval_tasks t
          WHERE t.instance_id = wi.id AND t.instance_id = ANY($1::bigint[])
            AND NOT EXISTS (
              SELECT 1 FROM approval_tasks t2
               WHERE t2.instance_id = wi.id AND t2.status = 'PENDING'
            )
            AND wi.status = 'RUNNING'`,
        [instanceIds]
      );
    }
  }
  const roleCodes = rolesOf(job);
  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  let notified = 0;
  if (escalated > 0) {
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'approval.escalated',
        title: `${escalated} approval${escalated === 1 ? '' : 's'} escalated`,
        body: `${escalated} approval task${escalated === 1 ? '' : 's'} pending longer than ${graceHours} hours have been escalated for senior review.`,
        link: '/my-work',
        priority: 'URGENT',
        severity: 'ERROR',
        actionLabel: 'Open My Work',
        actionTarget: '/my-work',
        channels: NAG_CHANNELS,
        data: { job: job.code, escalated, graceHours, instances: instanceIds.length },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { graceHours, escalated, instancesAffected: instanceIds.length, notified };
}


async function qualityQcPendingCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const graceHours = numParam(job, 'grace_hours', 4);
  const { rows } = await client.query(
    `SELECT i.id, i.inspection_no, i.kind, i.created_at, i.product_id, i.batch_id,
            b.batch_no, p.name AS product_name
       FROM inspections i
       LEFT JOIN product_batches b ON b.id = i.batch_id
       LEFT JOIN products p ON p.id = i.product_id
      WHERE i.tenant_id = $1
        AND i.result = 'PENDING'
        AND i.status = 'SUBMITTED'
        AND i.created_at < now() - ($2::int || ' hours')::interval
      ORDER BY i.created_at ASC
      LIMIT 50`,
    [ctx.tenantId, graceHours]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const inspectionNo = String(r.inspection_no ?? id);
    const batchNo = String(r.batch_no ?? inspectionNo);
    const productName = String(r.product_name ?? 'product');
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'quality.inspection_pending',
        title: `QC inspection pending: ${batchNo}`,
        body: `Inspection ${inspectionNo} (${String(r.kind)}) for ${productName} has been submitted and is awaiting QC review.`,
        link: `/quality/inspections/${id}`,
        entityType: 'inspection',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Review Inspection',
        actionTarget: `/quality/inspections/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, inspectionNo, batchNo, graceHours },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, pending: rows.length, notified };
}

async function productionOrderStaleCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const staleHours = numParam(job, 'stale_hours', 12);
  const { rows } = await client.query(
    `SELECT w.id, w.wo_no, w.status, w.updated_at, w.due_date, w.product_id, p.name AS product_name
       FROM work_orders w
       LEFT JOIN products p ON p.id = w.product_id
      WHERE w.tenant_id = $1
        AND w.status IN ('APPROVED','RELEASED','IN_PROGRESS')
        AND w.updated_at < now() - ($2::int || ' hours')::interval
      ORDER BY w.updated_at ASC
      LIMIT 50`,
    [ctx.tenantId, staleHours]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const woNo = String(r.wo_no ?? id);
    const productName = String(r.product_name ?? 'product');
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'production.work_order_stale',
        title: `${woNo} has no recent activity`,
        body: `Work order ${woNo} (${productName}) has not been updated for ${staleHours} hours. Please review.`,
        link: `/production/orders/${id}`,
        entityType: 'work_order',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Review Work Order',
        actionTarget: `/production/orders/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, woNo, productName, staleHours, status: r.status },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, stale: rows.length, notified };
}

async function inventoryDeadStockCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const days = numParam(job, 'days', 90);
  const { rows } = await client.query(
    `SELECT p.id, p.code, p.name, p.type,
            COALESCE(SUM(i.quantity), 0)::numeric AS on_hand,
            MAX(m.created_at) AS last_movement
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
       LEFT JOIN inventory_movements m ON m.product_id = p.id AND m.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1
        AND p.status = 'ACTIVE'
      GROUP BY p.id
     HAVING COALESCE(SUM(i.quantity), 0) > 0
        AND (MAX(m.created_at) IS NULL OR MAX(m.created_at) < now() - ($2::int || ' days')::interval)
      ORDER BY last_movement ASC NULLS FIRST
      LIMIT 50`,
    [ctx.tenantId, days]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const name = String(r.name);
    const code = String(r.code);
    const onHand = Number(r.on_hand);
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'inventory.dead_stock',
        title: `Dead stock: ${name}`,
        body: `${name} (${code}) has ${onHand} on hand with no movement for ${days} days.`,
        link: `/inventory/items/${id}`,
        entityType: 'product',
        entityId: id,
        priority: 'NORMAL',
        severity: 'INFO',
        actionLabel: 'Review Stock',
        actionTarget: `/inventory/items/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, itemCode: code, onHand, days },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, deadStock: rows.length, notified };
}

async function documentExpiryCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const windowDays = numParam(job, 'window_days', 30);
  const { rows } = await client.query(
    `SELECT d.id, d.doc_no, d.title, d.category, d.expires_at
       FROM documents d
      WHERE d.tenant_id = $1
        AND d.status = 'APPROVED'
        AND d.expires_at IS NOT NULL
        AND d.expires_at <= (CURRENT_DATE + $2::int)
      ORDER BY d.expires_at ASC
      LIMIT 50`,
    [ctx.tenantId, windowDays]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const docNo = String(r.doc_no ?? id);
    const title = String(r.title ?? 'document');
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'document.expiry',
        title: `${title} expires soon`,
        body: `Document ${docNo} (${title}) expires on ${String(r.expires_at)}.`,
        link: `/documents/${id}`,
        entityType: 'document',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'View Document',
        actionTarget: `/documents/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, docNo, title, windowDays, expiresAt: r.expires_at },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, expiring: rows.length, notified };
}

async function paymentDueReminder(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const days = numParam(job, 'days', 2);
  const { rows } = await client.query(
    `SELECT pr.id, pr.pay_no, pr.payee, pr.amount, pr.currency, pr.ref_code, pr.approved_at
       FROM payment_requests pr
      WHERE pr.tenant_id = $1
        AND pr.status = 'APPROVED'
        AND pr.paid_at IS NULL
        AND pr.approved_at IS NOT NULL
        AND pr.approved_at < now() - ($2::int || ' days')::interval
      ORDER BY pr.approved_at ASC
      LIMIT 50`,
    [ctx.tenantId, days]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const payNo = String(r.pay_no ?? id);
    const payee = String(r.payee ?? 'payee');
    const amount = String(r.amount ?? '0');
    const currency = String(r.currency ?? 'UGX');
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'finance.payment_due',
        title: `Payment ${payNo} is due`,
        body: `Approved payment ${payNo} to ${payee} (${amount} ${currency}) has not been paid within ${days} days.`,
        link: `/finance/payments/${id}`,
        entityType: 'payment_request',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Review Payment',
        actionTarget: `/finance/payments/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, payNo, payee, amount, currency, days },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, due: rows.length, notified };
}

// ---------------------------------------------------------------------------
// Attendance summary mail
// ---------------------------------------------------------------------------

/**
 * Audience the daily attendance summary is addressed to when the job row
 * carries no `notify_roles` of its own. Held here as well as in the seed so a
 * job created by hand, or an edited job whose params were cleared, still
 * reaches the right people.
 */
const ATTENDANCE_SUMMARY_ROLES: readonly string[] = [
  'hr_manager',
  'operations_manager',
  'managing_director',
];

/**
 * Collapse role-resolved rows into the list of addresses an email is actually
 * sent to. One person can hold more than one of the roles above, and the same
 * mailbox can sit on more than one user row, so the list is keyed on the
 * lowercased address: the first spelling seen wins and any later duplicate -
 * including one that differs only in case - is dropped. Blank rows are skipped
 * rather than turned into an empty recipient.
 */
export function dedupeEmails(rows: ReadonlyArray<{ email: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const email = String(row.email ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Daily attendance summary, mailed as a branded PDF at 19:30 Kampala.
 *
 * Two things about this handler are deliberate and easy to get wrong later:
 *
 *  1. The work day it reports is the KAMPALA day that is closing, not the
 *     server's. Every container in this deployment runs UTC with TZ unset, so
 *     a 19:30 EAT run happens at 16:30 UTC and the server's own date would
 *     already agree - but that agreement is a coincidence of the offset, and
 *     deriving the date in the company's zone keeps it correct if the run time
 *     is ever moved. (The seed therefore carries run_time '16:30'; see the 0186
 *     migration for why.)
 *
 *  2. A day with no captured records still sends, and says so in the subject
 *     line. An unattended attendance terminal is exactly the failure this
 *     report exists to surface, and a silently missing email cannot surface
 *     anything.
 *
 * Recipients are resolved from role codes rather than fixed addresses, so the
 * summary follows whoever holds the role. The same person can hold two of the
 * roles - the managing director here also holds operations_manager - so the
 * address list is de-duplicated by mailbox before the message is created.
 */
async function attendanceSummaryEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  job: CronJobRow
): Promise<Record<string, unknown>> {
  const configured = rolesOf(job);
  const roleCodes = configured.length > 0 ? configured : [...ATTENDANCE_SUMMARY_ROLES];
  const companyScope = ctx.companyId ?? null;

  const dayRes = await client.query(
    `SELECT (now() AT TIME ZONE 'Africa/Kampala')::date::text AS day,
            to_char(now() AT TIME ZONE 'Africa/Kampala', 'FMDay, FMDD FMMonth YYYY') AS label`
  );
  const day = String(dayRes.rows[0]?.day ?? '');
  const label = String(dayRes.rows[0]?.label ?? day);

  const totalsRes = await client.query(
    `SELECT count(*)::int AS records,
            count(*) FILTER (WHERE attendance_status = 'PRESENT')::int AS present,
            count(*) FILTER (WHERE attendance_status = 'LATE')::int AS late,
            count(*) FILTER (WHERE attendance_status = 'ABSENT')::int AS absent,
            count(*) FILTER (WHERE attendance_status = 'ON_LEAVE')::int AS on_leave,
            count(*) FILTER (WHERE attendance_status = 'EARLY_DEPARTURE')::int AS early_departure,
            count(*) FILTER (WHERE attendance_status = 'HALF_DAY')::int AS half_day,
            count(*) FILTER (WHERE attendance_status IN ('PENDING','EXCUSED'))::int AS awaiting,
            COALESCE(sum(late_minutes), 0)::int AS late_minutes,
            COALESCE(sum(overtime_minutes), 0)::int AS overtime_minutes,
            count(*) FILTER (WHERE check_in IS NOT NULL AND check_out IS NULL)::int AS still_on_duty
       FROM attendance_records
      WHERE tenant_id = $1
        AND work_date = $2::date
        AND ($3::bigint IS NULL OR company_id = $3)`,
    [ctx.tenantId, day, companyScope]
  );
  const totals = (totalsRes.rows[0] ?? {}) as Record<string, unknown>;
  const tally = (key: string): number => Number(totals[key] ?? 0);
  const records = tally('records');

  const activeRes = await client.query(
    `SELECT count(*)::int AS n
       FROM employees
      WHERE tenant_id = $1 AND status = 'ACTIVE'
        AND ($2::bigint IS NULL OR company_id = $2)`,
    [ctx.tenantId, companyScope]
  );
  const activeEmployees = Number((activeRes.rows[0] as Record<string, unknown>)?.n ?? 0);

  // Only the rows somebody has to look at: an absence, a late arrival, an early
  // departure, or a shift that never closed. The full roster would bury them.
  const excRes = await client.query(
    `SELECT COALESCE(NULLIF(e.employee_no, ''), NULLIF(e.employee_number, ''), e.id::text) AS emp_no,
            trim(concat_ws(' ', e.first_name, e.last_name)) AS name,
            COALESCE(dp.name, '') AS department,
            a.attendance_status AS status,
            CASE WHEN a.check_in IS NULL THEN ''
                 ELSE to_char(a.check_in AT TIME ZONE 'Africa/Kampala', 'HH24:MI') END AS check_in,
            CASE WHEN a.check_out IS NULL THEN ''
                 ELSE to_char(a.check_out AT TIME ZONE 'Africa/Kampala', 'HH24:MI') END AS check_out,
            COALESCE(a.late_minutes, 0)::int AS late_minutes
       FROM attendance_records a
       JOIN employees e ON e.id = a.employee_id AND e.tenant_id = a.tenant_id
       LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE a.tenant_id = $1
        AND a.work_date = $2::date
        AND ($3::bigint IS NULL OR a.company_id = $3)
        AND (a.attendance_status IN ('ABSENT','LATE','EARLY_DEPARTURE','HALF_DAY','EXCUSED')
             OR COALESCE(a.late_minutes, 0) > 0
             OR (a.check_in IS NOT NULL AND a.check_out IS NULL))
      ORDER BY (a.attendance_status = 'ABSENT') DESC, COALESCE(a.late_minutes, 0) DESC, name ASC
      LIMIT 200`,
    [ctx.tenantId, day, companyScope]
  );
  const exceptions = excRes.rows as Array<Record<string, unknown>>;

  const facts: Array<[string, string]> = [
    ['Work date', label],
    ['Records captured', String(records)],
    ['Present', String(tally('present'))],
    ['Late', String(tally('late'))],
    ['Absent', String(tally('absent'))],
    ['On leave', String(tally('on_leave'))],
    ['Early departure', String(tally('early_departure'))],
    ['Half day', String(tally('half_day'))],
    ['Awaiting review', String(tally('awaiting'))],
    ['Total late minutes', String(tally('late_minutes'))],
    ['Overtime minutes', String(tally('overtime_minutes'))],
    ['Still on duty', String(tally('still_on_duty'))],
    ['Active employees', String(activeEmployees)],
  ];

  const columns: BrandedTableColumn[] = [
    { key: 'emp_no', label: 'Employee No' },
    { key: 'name', label: 'Employee' },
    { key: 'department', label: 'Department' },
    { key: 'status', label: 'Status' },
    { key: 'check_in', label: 'In' },
    { key: 'check_out', label: 'Out' },
    { key: 'late_minutes', label: 'Late (min)', align: 'right' },
  ];

  const company = await loadCompanyProfile(client, ctx);
  const issuedAt = new Date().toISOString();
  const fingerprint = reportFingerprint('attendance.summary', columns.map((c) => c.key), exceptions);
  const pdf = await renderTablePdf({
    title: 'Daily Attendance Summary',
    subtitle: label,
    kicker: 'Workforce attendance',
    docNo: `ATT-${day}`,
    company,
    issuedBy: 'HOPE DESIGN ERP - scheduled report',
    issuedAt,
    facts,
    columns,
    rows: exceptions,
    fingerprint,
    classification: 'Internal',
  });

  const bodyLines = [
    `Attendance summary for ${label}.`,
    '',
    `Records captured: ${records}`,
    `Present: ${tally('present')}`,
    `Late: ${tally('late')}`,
    `Absent: ${tally('absent')}`,
    `On leave: ${tally('on_leave')}`,
    `Early departure: ${tally('early_departure')}`,
    `Half day: ${tally('half_day')}`,
    `Awaiting review: ${tally('awaiting')}`,
    `Total late minutes: ${tally('late_minutes')}`,
    `Overtime minutes: ${tally('overtime_minutes')}`,
    `Still on duty (checked in, not yet out): ${tally('still_on_duty')}`,
    '',
    `${exceptions.length} record${exceptions.length === 1 ? '' : 's'} need attention; they are listed in the attached PDF.`,
  ];
  if (records === 0) {
    bodyLines.push(
      '',
      'No attendance was captured for this date. Please confirm the attendance terminal was reachable.'
    );
  }
  bodyLines.push('', 'The full summary is attached as a PDF.');

  const userIds = await resolveRecipients(client, ctx, { roleCodes });
  const recipientRows =
    userIds.length > 0
      ? ((
          await client.query(
            `SELECT email
               FROM users
              WHERE tenant_id = $1 AND id = ANY($2::bigint[])
                AND status = 'ACTIVE' AND email IS NOT NULL AND email <> ''`,
            [ctx.tenantId, userIds]
          )
        ).rows as Array<{ email: string | null }>)
      : [];

  const to = dedupeEmails(recipientRows);

  if (to.length === 0) {
    // Loud on purpose: the addresses come from role assignments, so an empty
    // list means nobody holds the roles and the report reached no one.
    console.warn('[cronJobs] attendance summary has no recipients', { job: job.code, roleCodes });
    return { day, records, exceptions: exceptions.length, recipients: 0, sent: false };
  }

  const sent = await insertOutboundEmail(client, ctx, {
    to,
    subject: `Attendance Summary - ${label}`,
    body: bodyLines.join('\n'),
    classification: 'INTERNAL',
    attachments: [
      { filename: `attendance-summary-${day}.pdf`, content: pdf.toString('base64') },
    ],
  });

  return {
    day,
    records,
    exceptions: exceptions.length,
    recipients: to.length,
    emailId: sent.emailId,
    outcome: sent.outcome,
    error: sent.error ?? null,
    pdfBytes: pdf.length,
  };
}

async function quarantineAgingCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const days = numParam(job, 'days', 7);
  const { rows } = await client.query(
    `SELECT q.id, q.product_id, q.quantity, q.reason, q.created_at, p.name AS product_name
       FROM quarantine_records q
       LEFT JOIN products p ON p.id = q.product_id
      WHERE q.tenant_id = $1
        AND q.status = 'QUARANTINED'
        AND q.created_at < now() - ($2::int || ' days')::interval
      ORDER BY q.created_at ASC
      LIMIT 50`,
    [ctx.tenantId, days]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const name = String(r.product_name ?? 'product');
    const quantity = String(r.quantity ?? '0');
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'quality.quarantine_aging',
        title: `Quarantine aging: ${name}`,
        body: `${name} (${quantity}) has been in quarantine for ${days} days. Reason: ${String(r.reason ?? 'n/a')}.`,
        link: `/quality/quarantine/${id}`,
        entityType: 'quarantine_record',
        entityId: id,
        priority: 'HIGH',
        severity: 'WARN',
        actionLabel: 'Review Quarantine',
        actionTarget: `/quality/quarantine/${id}`,
        channels: NAG_CHANNELS,
        data: { job: job.code, productName: name, quantity, days, reason: r.reason },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, aged: rows.length, notified };
}

async function passwordExpiryCheck(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const days = numParam(job, 'days', 90);
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.must_change_password, u.password_changed_at
       FROM users u
      WHERE u.tenant_id = $1
        AND u.status = 'ACTIVE'
        AND (u.must_change_password = true OR u.password_changed_at IS NULL
             OR u.password_changed_at < now() - ($2::int || ' days')::interval)
      ORDER BY u.password_changed_at ASC NULLS FIRST
      LIMIT 50`,
    [ctx.tenantId, days]
  );
  const roleCodes = rolesOf(job);
  let notified = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const email = String(r.email ?? '');
    const displayName = [String(r.first_name ?? ''), String(r.last_name ?? '')].filter(Boolean).join(' ') || email;
    const userIds = await resolveRecipients(client, ctx, { roleCodes });
    await notifyUsers(
      client,
      ctx,
      {
        roleCodes,
        type: 'system.password_expiry',
        title: `Password change required for ${email}`,
        body: `User ${displayName} (${email}) requires a password change (${days} days since last change).`,
        link: `/settings/users/${id}`,
        entityType: 'user',
        entityId: id,
        priority: 'NORMAL',
        severity: 'INFO',
        actionLabel: 'Review User',
        actionTarget: `/settings/users/${id}`,
        channels: ['IN_APP', 'EMAIL'],
        data: { job: job.code, email, days, mustChange: r.must_change_password },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, expiring: rows.length, notified };
}

/**
 * Send the messages users queued, or scheduled for later.
 *
 * The flush never talks to the provider itself: it hands each due message to
 * `sendStoredEmail`, acting as that message's author, so a queued or scheduled
 * send goes out through exactly the same pipeline as a direct one -- mailbox
 * authorisation, classification and the approval gate, the author's signature,
 * and the message's ERP document attachment. A message whose author can no
 * longer be authorised is parked in the OUTBOX instead of being sent with those
 * pieces silently missing.
 */
async function emailQueueFlush(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `SELECT e.id, e.created_by
       FROM emails e
      WHERE e.tenant_id = $1
        AND e.status IN ('QUEUED','SCHEDULED')
        AND (e.scheduled_at IS NULL OR e.scheduled_at <= now())
      ORDER BY e.created_at ASC
      LIMIT 50`,
    [ctx.tenantId]
  );
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const reasons: Record<string, number> = {};
  const note = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const authorId = Number(r.created_by ?? 0);
    try {
      if (!authorId) throw new Error('This message has no author, so it cannot be sent.');
      // Acting as the author is what makes the mailbox check mean anything: the
      // message carries the mailbox it was composed from, and the permissions
      // used are the author's, as they were when the send was scheduled.
      const author = await loadAuthUser(authorId, ctx.tenantId ?? 0);
      const authorCtx: Ctx = {
        ...ctx,
        userId: author.id,
        companyId: author.company_id ?? ctx.companyId ?? null,
        branchId: author.branch_id ?? ctx.branchId ?? null,
      };
      // The row is due now, so the future-scheduled_at check must not park it
      // again; whatever the clock skew, this run is the one that sends it.
      const result = await sendStoredEmail(client, authorCtx, author.permissions, id, {
        forceNow: true,
      });
      if (result.outcome === 'SENT') {
        sent += 1;
      } else if (result.outcome === 'FAILED') {
        failed += 1;
        note(result.error ?? 'Sending failed');
      } else {
        // PENDING_APPROVAL: the classification needs a decision that was never
        // obtained, so the message correctly stops here rather than going out.
        skipped += 1;
        note(result.outcome);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not be sent';
      failed += 1;
      note(reason);
      await parkUnsendableEmail(client, ctx, id, reason, {
        permanent: isPermanentSendRefusal(error),
      });
    }
  }
  return { checked: rows.length, sent, failed, skipped, reasons };
}

/**
 * True when a send was refused for a reason no retry can change. Mailbox
 * authorisation is the case that matters: these retries act as the message's
 * author, so an author who holds no grant on the mailbox the message carries is
 * refused identically every time. Retrying that to the cap only delays the row
 * reaching FAILED and replaces the real cause with "Delivery attempts
 * exhausted", which says nothing about the missing grant an administrator has
 * to restore.
 */
const isPermanentSendRefusal = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * Park a message this flush could not authorise: no author, an author who is no
 * longer active, or a mailbox the author may not send from. Marking it FAILED and
 * moving it to the OUTBOX keeps it visible and manually retryable, and takes it
 * out of the queue so it is not sent the moment the missing authorisation is
 * restored, which is an administrator's decision to make rather than the cron's.
 */
async function parkUnsendableEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  emailId: number,
  reason: string,
  options: { permanent?: boolean } = {}
): Promise<void> {
  const tenantId = ctx.tenantId ?? 0;
  await client.query(
    `UPDATE emails SET status = 'FAILED', folder = 'OUTBOX', updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
  await client.query(
    `UPDATE email_recipients SET status = 'FAILED', error = $2, updated_at = now()
      WHERE email_id = $1 AND status = 'QUEUED'`,
    [emailId, reason]
  );
  if (options.permanent) {
    // Retrying cannot change the outcome, so the row is put straight at its
    // exhausted state instead of spending the remaining attempts to get there.
    await client.query(
      `INSERT INTO email_outbox
         (tenant_id, email_id, status, attempts, max_attempts, next_attempt_at, last_error)
       VALUES ($1,$2,'FAILED',1,1,NULL,$3)
       ON CONFLICT (email_id) DO UPDATE
         SET status = 'FAILED',
             attempts = email_outbox.max_attempts,
             next_attempt_at = NULL,
             last_error = EXCLUDED.last_error,
             updated_at = now()`,
      [tenantId, emailId, reason]
    );
    return;
  }
  await client.query(
    `INSERT INTO email_outbox (tenant_id, email_id, status, attempts, last_error)
     VALUES ($1,$2,'QUEUED',1,$3)
     ON CONFLICT (email_id) DO UPDATE
       SET status = 'QUEUED',
           attempts = email_outbox.attempts + 1,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [tenantId, emailId, reason]
  );
}



/**
 * Retry the messages the outbox is holding on to.
 *
 * `emailQueueFlush` only ever sees a message that has never been attempted: the
 * moment a send fails, `sendStoredEmail` marks the message FAILED and leaves it
 * in the OUTBOX, which the flush then skips. Without this job a delivery that
 * failed once stays parked until somebody retries it by hand, so a provider blip
 * on a message nobody is watching becomes a message that is never sent.
 *
 * The attempt cap is this job's boundary, not something it works around. Only
 * rows below `max_attempts` are read, a row that has reached the cap is moved
 * out of the eligible set and marked exhausted, and nothing here raises
 * `max_attempts`. Pushing a message past that line stays a manual decision.
 */
async function emailOutboxDrain(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const tenantId = ctx.tenantId ?? 0;

  // Rows at the cap are no longer eligible, so they are marked rather than left
  // looking queued forever with nothing describing why they stopped.
  const exhausted = await client.query(
    `UPDATE email_outbox
        SET status = 'FAILED', next_attempt_at = NULL, updated_at = now(),
            last_error = COALESCE(last_error, 'Delivery attempts exhausted')
      WHERE tenant_id = $1 AND status IN ('QUEUED','SENDING') AND attempts >= max_attempts`,
    [tenantId]
  );

  const { rows } = await client.query(
    `SELECT o.id, o.email_id, o.attempts, e.created_by
       FROM email_outbox o
       JOIN emails e ON e.id = o.email_id
      WHERE o.tenant_id = $1
        AND o.status IN ('QUEUED','SENDING')
        AND o.attempts < o.max_attempts
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
      ORDER BY o.queued_at ASC
      LIMIT 50`,
    [tenantId]
  );
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const reasons: Record<string, number> = {};
  const note = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  for (const r of rows as Record<string, unknown>[]) {
    const outboxId = Number(r.id);
    const emailId = Number(r.email_id);
    const attempts = Number(r.attempts ?? 0);
    try {
      const authorId = Number(r.created_by ?? 0);
      if (!authorId) throw new Error('This message has no author, so it cannot be sent.');
      // Acting as the author is what makes the mailbox check mean anything: the
      // message carries the mailbox it was composed from, and the permissions
      // used are the author's, as they were when the send was first attempted.
      const author = await loadAuthUser(authorId, tenantId);
      const authorCtx: Ctx = {
        ...ctx,
        userId: author.id,
        companyId: author.company_id ?? ctx.companyId ?? null,
        branchId: author.branch_id ?? ctx.branchId ?? null,
      };
      const result = await sendStoredEmail(client, authorCtx, author.permissions, emailId, {
        forceNow: true,
      });
      if (result.outcome === 'SENT') {
        sent += 1;
        await client.query(
          `UPDATE email_outbox
              SET status = 'SENT', sent_at = now(), last_error = NULL, next_attempt_at = NULL,
                  provider = $2, provider_message_id = $3, updated_at = now()
            WHERE id = $1`,
          [outboxId, result.provider ?? null, result.providerMessageId ?? null]
        );
      } else if (result.outcome === 'FAILED') {
        failed += 1;
        // sendStoredEmail has already counted this attempt and left the row
        // queued with no spacing, so the backoff is applied here.
        const reason = result.error ?? 'Sending failed';
        note(reason);
        await client.query(
          `UPDATE email_outbox
              SET next_attempt_at = now()
                    + (LEAST(30 * POWER(2, $2::int), 3600) * interval '1 second'),
                  last_error = $3, updated_at = now()
            WHERE id = $1`,
          [outboxId, attempts, reason]
        );
      } else {
        // A message held back for an approval decision is not this job's to
        // release; it is pushed out of the retry window so it does not spin.
        skipped += 1;
        note(result.outcome);
        await client.query(
          `UPDATE email_outbox
              SET next_attempt_at = now() + interval '1 hour', updated_at = now()
            WHERE id = $1`,
          [outboxId]
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not be sent';
      failed += 1;
      note(reason);
      await parkUnsendableEmail(client, ctx, emailId, reason, {
        permanent: isPermanentSendRefusal(error),
      });
    }
  }
  return {
    checked: rows.length,
    sent,
    failed,
    skipped,
    exhausted: exhausted.rowCount ?? 0,
    reasons,
  };
}

async function governanceAuthoritySweep(client: pg.PoolClient, ctx: Ctx): Promise<Record<string, unknown>> {
  const result = await governanceSweep(client, ctx);
  return {
    expiredDelegations: result.expiredDelegations,
    expiredSignatureProfiles: result.expiredSignatureProfiles,
  };
}
async function runHandler(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  switch (job.jobType) {
    case 'STOCK_REORDER_CHECK':
      return stockReorderCheck(client, ctx, job);
    case 'CONTRACT_EXPIRY_CHECK':
      return contractExpiryCheck(client, ctx, job);
    case 'ASSET_MAINTENANCE_CHECK':
      return assetMaintenanceCheck(client, ctx, job);
    case 'ASSET_INSPECTION_CHECK':
      return assetInspectionCheck(client, ctx, job);
    case 'CUSTODY_OVERDUE_CHECK':
      return custodyOverdueCheck(client, ctx, job);
    case 'WORK_ORDER_OVERDUE_CHECK':
      return workOrderOverdueCheck(client, ctx, job);
    case 'APPROVAL_ESCALATION':
      return approvalEscalation(client, ctx, job);
    case 'QUALITY_QC_PENDING_CHECK':
      return qualityQcPendingCheck(client, ctx, job);
    case 'PRODUCTION_ORDER_STALE_CHECK':
      return productionOrderStaleCheck(client, ctx, job);
    case 'INVENTORY_DEAD_STOCK_CHECK':
      return inventoryDeadStockCheck(client, ctx, job);
    case 'DOCUMENT_EXPIRY_CHECK':
      return documentExpiryCheck(client, ctx, job);
    case 'PAYMENT_DUE_REMINDER':
      return paymentDueReminder(client, ctx, job);
    case 'QUARANTINE_AGING_CHECK':
      return quarantineAgingCheck(client, ctx, job);
    case 'PASSWORD_EXPIRY_CHECK':
      return passwordExpiryCheck(client, ctx, job);
    case 'EMAIL_QUEUE_FLUSH':
      return emailQueueFlush(client, ctx, job);
    case 'EMAIL_OUTBOX_DRAIN':
      return emailOutboxDrain(client, ctx, job);
    case 'GOVERNANCE_AUTHORITY_SWEEP':
      return governanceAuthoritySweep(client, ctx);
    case 'ATTENDANCE_SUMMARY_EMAIL':
      return attendanceSummaryEmail(client, ctx, job);
    default:
      return { skipped: true, reason: `Unknown job type ${job.jobType}` };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Execute one cron job: run its handler, update the job, and log the run. */
export async function runCronJobRecord(job: CronJobRow, baseCtx: Ctx): Promise<{ ok: boolean; error?: string }> {
  const startedAt = Date.now();
  const ctx: Ctx = { ...baseCtx, tenantId: job.tenantId, companyId: job.companyId };
  try {
    await tx(async (client) => {
      let companyId = job.companyId;
      if (!companyId) {
        const company = await client.query('SELECT id FROM companies WHERE tenant_id = $1 AND code = $2', [job.tenantId, 'HDG']);
        companyId = company.rows[0]?.id ? Number(company.rows[0].id) : null;
      }
      const jobCtx: Ctx = { ...ctx, companyId };
      const summary = await runHandler(client, jobCtx, job);
      const next = nextRunFor(job, new Date());
      await client.query(
        `UPDATE cron_jobs
            SET last_run_at = now(), last_status = 'SUCCESS', last_error = NULL,
                last_run_duration_ms = $1, next_run_at = $2, updated_at = now()
          WHERE id = $3`,
        [Date.now() - startedAt, next.toISOString(), job.id]
      );
      await client.query(
        `INSERT INTO cron_job_runs
           (tenant_id, company_id, branch_id, job_id, status, started_at, finished_at, duration_ms, details)
         VALUES ($1,$2,$3,$4,'SUCCESS', to_timestamp($5 / 1000.0), now(), $6, $7::jsonb)`,
        [job.tenantId, companyId, job.branchId, job.id, startedAt, Date.now() - startedAt, JSON.stringify(summary)]
      );
      await logAudit(client, ctx, {
        action: 'run',
        resource: 'cron.job',
        recordId: job.id,
        recordCode: job.code,
        metadata: { jobType: job.jobType, companyId, ...summary },
      });
    }, ctx);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await tx(async (client) => {
        await client.query(
          `UPDATE cron_jobs
              SET last_run_at = now(), last_status = 'FAILED', last_error = $1,
                  last_run_duration_ms = $2, next_run_at = $3, updated_at = now()
            WHERE id = $4`,
          [msg, Date.now() - startedAt, nextRunFor(job, new Date()).toISOString(), job.id]
        );
        await client.query(
          `INSERT INTO cron_job_runs
             (tenant_id, company_id, branch_id, job_id, status, started_at, finished_at, duration_ms, error)
           VALUES ($1,$2,$3,$4,'FAILED', to_timestamp($5 / 1000.0), now(), $6, $7)`,
          [job.tenantId, job.companyId, job.branchId, job.id, startedAt, Date.now() - startedAt, msg]
        );
      }, ctx);
    } catch (err2) {
      const m2 = err2 instanceof Error ? err2.message : String(err2);
      console.error('[cronJobs] failed to record run failure', job.id, m2);
    }
    console.error('[cronJobs] job failed', job.id, job.code, msg);
    return { ok: false, error: msg };
  }
}

let running = false;

/** Process every due enabled cron job across all tenants (single-flight). */
export async function runDueCronJobs(): Promise<{ processed: number; ok: number; failed: number }> {
  if (running) return { processed: 0, ok: 0, failed: 0 };
  running = true;
  try {
    const res = await query('SELECT * FROM get_due_cron_jobs()');
    const due = (res.rows as Record<string, unknown>[]).map(toCronJobRow);
    let ok = 0;
    let failed = 0;
    for (const job of due) {
      const outcome = await runCronJobRecord(job, {});
      if (outcome.ok) ok += 1;
      else failed += 1;
    }
    return { processed: due.length, ok, failed };
  } finally {
    running = false;
  }
}

/** Manual run of a specific job (admin). Returns outcome summary. */
export async function runCronJobById(jobId: number): Promise<{ ok: boolean; error?: string }> {
  const res = await query('SELECT * FROM cron_jobs WHERE id = $1', [jobId]);
  if (res.rows.length === 0) return { ok: false, error: 'Job not found' };
  return runCronJobRecord(toCronJobRow(res.rows[0] as Record<string, unknown>), {});
}
