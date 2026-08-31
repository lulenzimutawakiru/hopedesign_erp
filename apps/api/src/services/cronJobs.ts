import pg from 'pg';
import { Ctx, query, tx } from '../db.js';
import { logAudit } from './audit.js';
import { notifyUsers, resolveRecipients } from './communication.js';
import { sendEmail } from './bird.js';
import { computeNextRun } from './reportScheduler.js';

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

function nextRunFor(job: CronJobRow, from: Date): Date {
  if (job.scheduleType === 'INTERVAL' && job.intervalMinutes && job.intervalMinutes > 0) {
    return new Date(from.getTime() + job.intervalMinutes * 60_000);
  }
  if (job.scheduleType === 'ONCE') {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  return computeNextRun(job.scheduleType, job.runTime || '08:00', job.dayOfWeek, job.dayOfMonth, from);
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
        channels: ['IN_APP', 'EMAIL'],
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
        channels: ['IN_APP', 'EMAIL'],
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
        channels: ['IN_APP', 'EMAIL'],
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
        channels: ['IN_APP', 'EMAIL'],
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
        channels: ['IN_APP', 'EMAIL'],
        data: { job: job.code, payNo, payee, amount, currency, days },
      },
      userIds
    );
    notified += userIds.length;
  }
  return { checked: rows.length, due: rows.length, notified };
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
        channels: ['IN_APP', 'EMAIL'],
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

async function emailQueueFlush(client: pg.PoolClient, ctx: Ctx, job: CronJobRow): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `SELECT e.id, e.subject, e.body, e.to, e.entity_type, e.entity_id
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
  for (const r of rows as Record<string, unknown>[]) {
    const id = Number(r.id);
    const toAddresses: string[] = [];
    try {
      const raw = JSON.parse(String(r.to ?? '[]')) as unknown[];
      for (const entry of raw) {
        if (typeof entry === 'string') toAddresses.push(entry);
        else if (entry && typeof entry === 'object' && 'email' in entry) {
          const maybe = (entry as { email?: unknown }).email;
          if (typeof maybe === 'string') toAddresses.push(maybe);
        }
      }
    } catch {
      // invalid JSON in "to" -> leave empty, email will be marked failed below
    }
    if (toAddresses.length === 0) {
      await client.query(`UPDATE emails SET status = 'FAILED', sent_at = now() WHERE id = $1`, [id]);
      failed += 1;
      continue;
    }
    const subject = String(r.subject ?? 'HOPE DESIGN ERP');
    const body = String(r.body ?? '');
    const result = await sendEmail({ to: toAddresses, subject, html: body, text: body });
    if (result.ok) {
      await client.query(`UPDATE emails SET status = 'SENT', sent_at = now() WHERE id = $1`, [id]);
      sent += 1;
    } else {
      await client.query(
        `UPDATE emails SET status = 'FAILED', sent_at = now(), body = body WHERE id = $1`,
        [id]
      );
      failed += 1;
    }
  }
  return { checked: rows.length, sent, failed };
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
