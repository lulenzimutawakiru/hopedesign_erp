import { Ctx, query, tx } from '../db.js';
import { logAudit } from './audit.js';
import { notifyUserAdvanced } from './communication.js';
import { buildCountSql, columnsOf, reportDef } from './reportCore.js';

/** Next occurrence of a schedule after `from` (strictly in the future).
 *  Weekdays use ISO numbering: 1 = Monday .. 7 = Sunday. */
export function computeNextRun(
  frequency: string,
  runTime: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  from: Date
): Date {
  const parts = runTime.split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const at = (d: Date) => {
    const c = new Date(d);
    c.setHours(h, m, 0, 0);
    return c;
  };
  const freq = String(frequency ?? 'DAILY').toUpperCase();
  if (freq === 'WEEKLY') {
    const targetJs = dayOfWeek === 7 ? 0 : dayOfWeek; // 1=Mon..6=Sat, 7=Sun(0)
    let cand = at(from);
    if (cand.getTime() <= from.getTime()) cand.setDate(cand.getDate() + 1);
    let guard = 0;
    while (cand.getDay() !== targetJs && guard < 8) {
      cand.setDate(cand.getDate() + 1);
      guard += 1;
    }
    return cand;
  }
  if (freq === 'MONTHLY') {
    const target = dayOfMonth && dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : 1;
    const lastDay = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const day = Math.min(target, lastDay(from));
    let cand = at(new Date(from.getFullYear(), from.getMonth(), day));
    if (cand.getTime() <= from.getTime()) {
      const next = new Date(from.getFullYear(), from.getMonth() + 1, 1);
      const nextDay = Math.min(target, lastDay(next));
      cand = at(new Date(next.getFullYear(), next.getMonth(), nextDay));
    }
    return cand;
  }
  // DAILY (and ONCE) -> next occurrence of the run time.
  let cand = at(from);
  if (cand.getTime() <= from.getTime()) cand.setDate(cand.getDate() + 1);
  return cand;
}

/** Normalize recipients (user ids, emails, or {userId|email} objects) to a
 *  list of active tenant users. Unknown emails are dropped, never guessed. */
export async function resolveRecipients(
  tenantId: number | null | undefined,
  raw: unknown
): Promise<{ userId: number; email: string }[]> {
  const ids: number[] = [];
  const emails: string[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (typeof r === 'number' && Number.isFinite(r)) ids.push(Math.trunc(r));
      else if (typeof r === 'string' && r.trim()) emails.push(r.trim().toLowerCase());
      else if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        if (o.userId !== undefined && o.userId !== null && Number.isFinite(Number(o.userId))) ids.push(Math.trunc(Number(o.userId)));
        if (typeof o.email === 'string' && o.email.trim()) emails.push(o.email.trim().toLowerCase());
      }
    }
  }
  if (ids.length === 0 && emails.length === 0) return [];
  const res = await query(
    `SELECT id, email FROM users
     WHERE tenant_id = $1 AND status = 'ACTIVE'
       AND (id = ANY($2::bigint[]) OR lower(email) = ANY($3::text[]))`,
    [tenantId ?? -1, ids.length ? ids : [0], emails.length ? emails : ['__none__']]
  );
  return (res.rows as { id: number; email: string }[]).map((r) => ({
    userId: Number(r.id),
    email: String(r.email),
  }));
}

export interface ScheduleRow {
  id: number;
  tenant_id: number;
  company_id: number | null;
  created_by: number | null;
  name: string;
  report_name: string;
  filters: unknown;
  frequency: string;
  run_time: string;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: unknown;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
}

export function toScheduleRow(row: Record<string, unknown>): ScheduleRow {
  return {
    id: Number(row.id),
    tenant_id: Number(row.tenant_id),
    company_id: row.company_id === null || row.company_id === undefined ? null : Number(row.company_id),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    name: String(row.name ?? ''),
    report_name: String(row.report_name ?? ''),
    filters: row.filters ?? {},
    frequency: String(row.frequency ?? 'DAILY'),
    run_time: String(row.run_time ?? '08:00').slice(0, 5),
    day_of_week: row.day_of_week === null || row.day_of_week === undefined ? null : Number(row.day_of_week),
    day_of_month: row.day_of_month === null || row.day_of_month === undefined ? null : Number(row.day_of_month),
    recipients: row.recipients ?? [],
    enabled: !!row.enabled,
    next_run_at: String(row.next_run_at ?? ''),
    last_run_at: row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
    last_status: row.last_status === null || row.last_status === undefined ? null : String(row.last_status),
  };
}

/** Execute one schedule: run the report query scoped to the schedule company,
 *  notify every recipient, record the delivery, and update the schedule. */
export async function runScheduleRecord(sched: ScheduleRow, baseCtx: Ctx): Promise<{ ok: boolean; rows: number; error?: string }> {
  const def = reportDef(sched.report_name);
  if (!def) return { ok: false, rows: 0, error: 'Unknown report' };
  const ctx: Ctx = {
    ...baseCtx,
    tenantId: sched.tenant_id,
    companyId: sched.company_id,
    userId: sched.created_by ?? baseCtx.userId,
  };

  const deliveryId = await tx(async (client) => {
    const r = await client.query(
      `INSERT INTO report_deliveries
        (tenant_id, company_id, schedule_id, created_by, report_name, filters, recipients, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'RUNNING',now()) RETURNING id`,
      [
        sched.tenant_id,
        sched.company_id,
        sched.id,
        sched.created_by,
        def.name,
        JSON.stringify(sched.filters ?? {}),
        JSON.stringify(sched.recipients ?? []),
      ]
    );
    return Number(r.rows[0].id);
  }, ctx);

  try {
    const cols = await columnsOf(def.table);
    const { sql, params } = buildCountSql(def, cols, (sched.filters ?? {}) as Record<string, unknown>, sched.company_id);
    const res = await query(sql, params, ctx);
    const total = Number(res.rows[0]?.total ?? 0);
    const recipients = await resolveRecipients(sched.tenant_id, sched.recipients);

    await tx(async (client) => {
      await client.query(
        `UPDATE report_deliveries SET status='COMPLETED', row_count=$1, finished_at=now(), error=NULL WHERE id=$2`,
        [total, deliveryId]
      );
      await client.query(
        `UPDATE report_schedules
         SET last_run_at=now(), last_status='COMPLETED',
             next_run_at=$1,
             enabled = CASE WHEN $2 THEN false ELSE enabled END,
             updated_at=now()
         WHERE id=$3`,
        [
          computeNextRun(sched.frequency, sched.run_time, sched.day_of_week, sched.day_of_month, new Date()).toISOString(),
          sched.frequency === 'ONCE',
          sched.id,
        ]
      );
      for (const r of recipients) {
        await notifyUserAdvanced(client, ctx, r.userId, {
          type: 'report.delivery',
          title: `Report ready: ${def.label}`,
          body: `${total.toLocaleString()} row${total === 1 ? '' : 's'} delivered`,
          link: `/reports?report=${def.name}`,
          entityType: 'report_schedule',
          entityId: sched.id,
          severity: 'INFO',
          data: { report: def.name, rows: total },
        });
      }
      await logAudit(client, ctx, {
        action: 'run',
        resource: 'report.schedule',
        recordId: sched.id,
        metadata: { report: def.name, deliveryId, rows: total, recipients: recipients.length },
      });
    }, ctx);
    return { ok: true, rows: total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const recipients = await resolveRecipients(sched.tenant_id, sched.recipients).catch(() => []);
    await tx(async (client) => {
      await client.query(
        `UPDATE report_deliveries SET status='FAILED', error=$1, finished_at=now() WHERE id=$2`,
        [msg, deliveryId]
      );
      const next = sched.frequency === 'ONCE' ? new Date(Date.now() + 60 * 60 * 1000) : computeNextRun(sched.frequency, sched.run_time, sched.day_of_week, sched.day_of_month, new Date());
      await client.query(
        `UPDATE report_schedules SET last_run_at=now(), last_status='FAILED', next_run_at=$1, updated_at=now() WHERE id=$2`,
        [next.toISOString(), sched.id]
      );
      for (const r of recipients) {
        await notifyUserAdvanced(client, ctx, r.userId, {
          type: 'report.delivery',
          title: `Report delivery failed: ${def.label}`,
          body: msg,
          link: `/reports?report=${def.name}`,
          entityType: 'report_schedule',
          entityId: sched.id,
          severity: 'ERROR',
          actionRequired: true,
          data: { report: def.name, deliveryId, error: msg },
        });
      }
      await logAudit(client, ctx, {
        action: 'run_failed',
        resource: 'report.schedule',
        recordId: sched.id,
        metadata: { report: def.name, deliveryId, error: msg },
      });
    }, ctx);
    console.error('[reportScheduler] delivery failed', sched.id, msg);
    return { ok: false, rows: 0, error: msg };
  }
}

let running = false;

/** Process every due enabled schedule across all tenants. Called by the
 *  background interval and the manual /process endpoint (single-flight). */
export async function runDueReportSchedules(): Promise<{ processed: number; ok: number; failed: number }> {
  if (running) return { processed: 0, ok: 0, failed: 0 };
  running = true;
  try {
    const res = await query('SELECT * FROM get_due_report_schedules()');
    const due = (res.rows as Record<string, unknown>[]).map(toScheduleRow);
    let ok = 0;
    let failed = 0;
    for (const s of due) {
      const outcome = await runScheduleRecord(s, {});
      if (outcome.ok) ok += 1;
      else failed += 1;
    }
    return { processed: due.length, ok, failed };
  } finally {
    running = false;
  }
}
