/**
 * Hikvision attendance administration: attendance records, employee daily
 * views, attendance periods (submit/approve/lock -> payroll gate) and manual
 * adjustments. Every read is org-scoped (ABAC) and every write is audited.
 * Approved or locked data is immutable outside the adjustment workflow.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../utils.js';
import { logAudit } from '../audit.js';
import { computeMetrics } from './calc.js';
import { cleanInt, cleanStr, resolveOrg, OrgScope } from './adminCommon.js';
import { zonedDateTimeToUtc } from './time.js';

const RECORD_SQL = `
  SELECT a.id, a.tenant_id, a.company_id, a.branch_id, a.department_id, a.employee_id,
         a.work_date, a.period_id, a.shift_id, a.shift_code, a.scheduled_start, a.scheduled_end,
         a.grace_minutes, a.break_minutes, a.check_in, a.check_out, a.break_start, a.break_end,
         a.scheduled_minutes, a.worked_minutes, a.actual_minutes, a.late_minutes,
         a.early_departure_minutes, a.overtime_minutes, a.undertime_minutes,
         a.attendance_status, a.approval_status, a.source, a.raw_punch_count, a.notes,
         a.reviewed_by, a.reviewed_at, a.approved_by, a.approved_at, a.created_at, a.updated_at,
         e.employee_no, e.employee_number, e.first_name, e.last_name, e.position, e.status AS employee_status,
         dp.name AS department_name, b.name AS branch_name, p.period_code, p.period_name,
         p.status AS period_status
    FROM attendance_records a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN departments dp ON dp.id = COALESCE(a.department_id, e.department_id)
    LEFT JOIN branches b ON b.id = COALESCE(a.branch_id, e.branch_id)
    LEFT JOIN attendance_periods p ON p.id = a.period_id`;

/** attendance_records carries its own branch/department columns; a branch- or
 *  department-bound caller is confined via COALESCE to the employee's own. */
function recScopeClause(scope: OrgScope): { clause: string; params: unknown[] } {
  const conds: string[] = ['a.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`a.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`COALESCE(a.branch_id, e.branch_id) = $${params.length}`);
  }
  if (scope.departmentId !== null) {
    params.push(scope.departmentId);
    conds.push(`COALESCE(a.department_id, e.department_id) = $${params.length}`);
  }
  return { clause: conds.join(' AND '), params };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EARLY_DEPARTURE', 'ON_LEAVE', 'HOLIDAY', 'HALF_DAY', 'PENDING', 'EXCUSED'];
const APPROVAL = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ADJUSTED'];

function pageOf(q: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, cleanInt(q.page, 1_000_000, 1) ?? 1);
  const pageSize = Math.min(200, cleanInt(q.pageSize, 200, 1) ?? 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function mapRecord(row: Record<string, unknown>): Record<string, unknown> {
  const employeeId = Number(row.employee_id);
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    companyId: Number(row.company_id),
    branchId: row.branch_id != null ? Number(row.branch_id) : null,
    departmentId: row.department_id != null ? Number(row.department_id) : null,
    employeeId,
    employee: {
      id: employeeId,
      employeeNo: row.employee_no,
      employeeNumber: row.employee_number,
      name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
      position: row.position,
    },
    departmentName: row.department_name,
    branchName: row.branch_name,
    workDate: row.work_date,
    periodId: row.period_id != null ? Number(row.period_id) : null,
    period: row.period_id != null
      ? { id: Number(row.period_id), code: row.period_code, name: row.period_name, status: row.period_status }
      : null,
    shiftId: row.shift_id != null ? Number(row.shift_id) : null,
    shiftCode: row.shift_code,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    graceMinutes: Number(row.grace_minutes ?? 0),
    breakMinutes: Number(row.break_minutes ?? 0),
    checkIn: row.check_in,
    checkOut: row.check_out,
    breakStart: row.break_start,
    breakEnd: row.break_end,
    scheduledMinutes: row.scheduled_minutes != null ? Number(row.scheduled_minutes) : null,
    workedMinutes: row.worked_minutes != null ? Number(row.worked_minutes) : null,
    actualMinutes: row.actual_minutes != null ? Number(row.actual_minutes) : null,
    lateMinutes: Number(row.late_minutes ?? 0),
    earlyDepartureMinutes: Number(row.early_departure_minutes ?? 0),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    undertimeMinutes: Number(row.undertime_minutes ?? 0),
    attendanceStatus: row.attendance_status,
    approvalStatus: row.approval_status,
    source: row.source,
    rawPunchCount: Number(row.raw_punch_count ?? 0),
    notes: row.notes,
    reviewedAt: row.reviewed_at,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Attendance record list with org scope + optional filters. */
export async function listAttendance(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const scoped = recScopeClause(scope);
  const conds = [scoped.clause];
  const params: unknown[] = [...scoped.params];

  const from = cleanDate(q.dateFrom ?? q.workDateFrom);
  if (from) { params.push(from); conds.push(`a.work_date >= $${params.length}::date`); }
  const to = cleanDate(q.dateTo ?? q.workDateTo);
  if (to) { params.push(to); conds.push(`a.work_date <= $${params.length}::date`); }
  const employeeId = cleanInt(q.employeeId);
  if (employeeId !== null) { params.push(employeeId); conds.push(`a.employee_id = $${params.length}`); }
  const departmentId = cleanInt(q.departmentId);
  if (departmentId !== null) { params.push(departmentId); conds.push(`COALESCE(a.department_id, e.department_id) = $${params.length}`); }
  const periodId = cleanInt(q.periodId);
  if (periodId !== null) { params.push(periodId); conds.push(`a.period_id = $${params.length}`); }
  const status = cleanStr(q.attendanceStatus ?? q.status, 24);
  if (status) {
    if (!STATUSES.includes(status)) throw badRequest('Invalid attendance status filter');
    params.push(status); conds.push(`a.attendance_status = $${params.length}`);
  }
  const approval = cleanStr(q.approvalStatus, 24);
  if (approval) {
    if (!APPROVAL.includes(approval)) throw badRequest('Invalid approval status filter');
    params.push(approval); conds.push(`a.approval_status = $${params.length}`);
  }
  const text = cleanStr(q.q, 80);
  if (text) {
    params.push(`%${text}%`);
    conds.push(`(e.employee_no ILIKE $${params.length} OR e.employee_number ILIKE $${params.length} OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${params.length})`);
  }
  const where = conds.join(' AND ');
  const totalRes = await c.query(
    `SELECT count(*)::int AS total FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE ${where}`,
    params
  );
  const pg = pageOf(q);
  const rowsRes = await c.query(
    `${RECORD_SQL} WHERE ${where} ORDER BY a.work_date DESC, e.employee_no LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pg.pageSize, pg.offset]
  );
  return {
    items: rowsRes.rows.map((r) => mapRecord(r as unknown as Record<string, unknown>)),
    total: Number(totalRes.rows[0]?.total ?? 0),
    page: pg.page,
    pageSize: pg.pageSize,
  };
}async function fetchScopedRecord(c: pg.PoolClient, scope: OrgScope, id: number): Promise<Record<string, unknown>> {
  const scoped = recScopeClause(scope);
  const res = await c.query(
    `${RECORD_SQL} WHERE ${scoped.clause} AND a.id = $${scoped.params.length + 1}`,
    [...scoped.params, id]
  );
  if (res.rows.length === 0) throw notFound('Attendance record not found');
  return res.rows[0] as unknown as Record<string, unknown>;
}

/** Record detail: punches, exceptions, adjustments and audit history. */
export async function getAttendanceDetail(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchScopedRecord(c, scope, id);
  const recId = Number(row.id);
  const tenantId = Number(row.tenant_id);
  const [punches, exceptions, adjustments, audit] = await Promise.all([
    c.query(
      `SELECT p.id, p.punch_time, p.punch_type, p.verification_method, p.device_purpose,
              p.location, p.segment, p.metadata, p.device_id, p.created_at,
              d.code AS device_code, d.name AS device_name
         FROM attendance_punch_events p
         LEFT JOIN hikvision_devices d ON d.id = p.device_id
        WHERE p.attendance_record_id = $1 AND p.tenant_id = $2
        ORDER BY p.punch_time`,
      [recId, tenantId]
    ),
    c.query(
      `SELECT id, exception_type, severity, status, employee_identifier, event_time,
              summary, resolution, assigned_to, created_at
         FROM attendance_exceptions
        WHERE attendance_record_id = $1 AND tenant_id = $2
        ORDER BY id DESC`,
      [recId, tenantId]
    ),
    c.query(
      `SELECT id, adjustment_type, reason, status, previous_values, new_values,
              requested_by, approved_by, approved_at, created_at
         FROM attendance_adjustments
        WHERE attendance_record_id = $1 AND tenant_id = $2
        ORDER BY id DESC`,
      [recId, tenantId]
    ),
    c.query(
      `SELECT action, user_id, record_id, old_values, new_values, metadata, ip, created_at
         FROM audit_logs
        WHERE resource = 'attendance_records' AND record_id = $1 AND tenant_id = $2
        ORDER BY id DESC LIMIT 50`,
      [recId, tenantId]
    ),
  ]);
  return {
    record: mapRecord(row),
    punches: punches.rows,
    exceptions: exceptions.rows,
    adjustments: adjustments.rows,
    auditHistory: audit.rows,
  };
}

/** Employee monthly attendance (defaults to the current month). */
export async function employeeAttendance(
  c: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  q: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const empParams: unknown[] = [scope.tenantId];
  let empWhere = 'e.id = $2';
  if (scope.companyId !== null) { empParams.push(scope.companyId); empWhere += ` AND e.company_id = $${empParams.length}`; }
  if (scope.branchId !== null) { empParams.push(scope.branchId); empWhere += ` AND COALESCE(e.branch_id, e.department_id) IS NOT NULL AND e.branch_id = $${empParams.length}`; }
  const empRes = await c.query(
    `SELECT id, employee_no, first_name, last_name, position, company_id, branch_id, department_id, status
       FROM employees e WHERE ${empWhere} LIMIT 1`,
    [empParams[0], employeeId, ...empParams.slice(1)]
  );
  if (empRes.rows.length === 0) throw notFound('Employee not found');
  const emp = empRes.rows[0] as unknown as Record<string, unknown>;

  const now = new Date();
  const from = cleanDate(q.month) !== null
    ? `${String(q.month).slice(0, 7)}-01`
    : cleanDate(q.dateFrom) ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = cleanDate(q.dateTo) ?? new Date().toISOString().slice(0, 10);

  const params: unknown[] = [scope.tenantId, Number(emp.id), from, to];
  const conds: string[] = ['a.tenant_id = $1', 'a.employee_id = $2', 'a.work_date >= $3::date', 'a.work_date <= $4::date'];
  if (scope.companyId !== null) { params.push(scope.companyId); conds.push(`a.company_id = $${params.length}`); }
  const where = conds.join(' AND ');

  const rowsRes = await c.query(`${RECORD_SQL} WHERE ${where} ORDER BY a.work_date`, params);
  const summaryRes = await c.query(
    `SELECT count(*) FILTER (WHERE a.attendance_status = 'PRESENT')::int AS present,
            count(*) FILTER (WHERE a.attendance_status = 'ABSENT')::int AS absent,
            count(*) FILTER (WHERE a.attendance_status = 'LATE')::int AS late,
            count(*) FILTER (WHERE a.attendance_status = 'EARLY_DEPARTURE')::int AS early_departure,
            count(*) FILTER (WHERE a.attendance_status = 'ON_LEAVE')::int AS on_leave,
            count(*) FILTER (WHERE a.attendance_status = 'HOLIDAY')::int AS holiday,
            count(*) FILTER (WHERE a.attendance_status = 'HALF_DAY')::int AS half_day,
            count(*) FILTER (WHERE a.attendance_status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE a.attendance_status = 'EXCUSED')::int AS excused,
            COALESCE(sum(a.late_minutes), 0)::int AS late_minutes,
            COALESCE(sum(a.overtime_minutes), 0)::int AS overtime_minutes,
            COALESCE(sum(a.undertime_minutes), 0)::int AS undertime_minutes,
            COALESCE(sum(a.worked_minutes), 0)::int AS worked_minutes
       FROM attendance_records a WHERE ${where}`,
    params
  );
  return {
    employee: {
      id: Number(emp.id),
      employeeNo: emp.employee_no,
      employeeNumber: emp.employee_number ?? null,
      name: `${emp.first_name ?? ''} ${emp.last_name ?? ''}`.trim(),
      position: emp.position,
    },
    from,
    to,
    records: rowsRes.rows.map((r) => mapRecord(r as unknown as Record<string, unknown>)),
    summary: summaryRes.rows[0] ?? {},
  };
}// ---- Attendance periods (approval + payroll lock gate) ----------------------
function periodScope(scope: OrgScope): { clause: string; params: unknown[] } {
  const conds: string[] = ['p.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`p.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`(p.branch_id IS NULL OR p.branch_id = $${params.length})`);
  }
  return { clause: conds.join(' AND '), params };
}

async function fetchPeriod(c: pg.PoolClient, scope: OrgScope, periodId: number): Promise<Record<string, unknown>> {
  const scoped = periodScope(scope);
  const res = await c.query(
    `SELECT p.*, b.name AS branch_name
       FROM attendance_periods p
       LEFT JOIN branches b ON b.id = p.branch_id
      WHERE ${scoped.clause} AND p.id = $${scoped.params.length + 1}`,
    [...scoped.params, periodId]
  );
  if (res.rows.length === 0) throw notFound('Attendance period not found');
  return res.rows[0] as unknown as Record<string, unknown>;
}

export async function listAttendancePeriods(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const scoped = periodScope(scope);
  const conds = [scoped.clause];
  const params: unknown[] = [...scoped.params];
  const status = cleanStr(q.status, 24);
  if (status) {
    if (!['OPEN', 'PENDING_APPROVAL', 'APPROVED', 'LOCKED'].includes(status)) throw badRequest('Invalid period status');
    params.push(status); conds.push(`p.status = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const rowsRes = await c.query(
    `SELECT p.*, b.name AS branch_name,
            (SELECT count(*)::int FROM attendance_records r WHERE r.period_id = p.id) AS record_count,
            (SELECT count(*)::int FROM attendance_records r WHERE r.period_id = p.id AND r.approval_status = 'APPROVED') AS approved_count
       FROM attendance_periods p
       LEFT JOIN branches b ON b.id = p.branch_id
      WHERE ${where}
      ORDER BY p.end_date DESC, p.id DESC LIMIT 500`,
    params
  );
  return {
    items: rowsRes.rows.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      return {
        id: Number(x.id),
        periodCode: x.period_code,
        periodName: x.period_name,
        companyId: Number(x.company_id),
        branchId: x.branch_id != null ? Number(x.branch_id) : null,
        branchName: x.branch_name,
        startDate: x.start_date,
        endDate: x.end_date,
        status: x.status,
        notes: x.notes,
        recordCount: Number(x.record_count ?? 0),
        approvedCount: Number(x.approved_count ?? 0),
        submittedAt: x.submitted_at,
        approvedAt: x.approved_at,
        lockedAt: x.locked_at,
        createdAt: x.created_at,
      };
    }),
  };
}

/** Create an OPEN attendance period (company-wide or per branch). */
export async function createAttendancePeriod(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  if (scope.companyId === null) throw badRequest('companyId is required to create an attendance period');
  const code = cleanStr(body.periodCode, 64);
  if (!code) throw badRequest('periodCode is required');
  const name = cleanStr(body.periodName, 160) ?? code;
  const startDate = cleanDate(body.startDate);
  const endDate = cleanDate(body.endDate);
  if (!startDate || !endDate) throw badRequest('startDate and endDate are required (YYYY-MM-DD)');
  if (startDate > endDate) throw badRequest('startDate must not be after endDate');
  const notes = cleanStr(body.notes, 500);

  const dup = await c.query(
    `SELECT id FROM attendance_periods WHERE company_id = $1 AND period_code = $2 AND tenant_id = $3`,
    [scope.companyId, code, scope.tenantId]
  );
  if (dup.rows.length > 0) throw badRequest('A period with this code already exists');
  const overlap = await c.query(
    `SELECT id, period_code FROM attendance_periods
      WHERE company_id = $1 AND tenant_id = $3
        AND start_date <= $4::date AND end_date >= $2::date
        AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $5)
      LIMIT 1`,
    [scope.companyId, startDate, scope.tenantId, endDate, scope.branchId ?? null]
  );
  if (overlap.rows.length > 0) throw badRequest(`Period overlaps existing period ${String(overlap.rows[0].period_code)}`);

  const ins = await c.query(
    `INSERT INTO attendance_periods
       (tenant_id, company_id, branch_id, period_code, period_name, start_date, end_date, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,'OPEN',$8,$9)
     RETURNING id`,
    [scope.tenantId, scope.companyId, scope.branchId, code, name, startDate, endDate, notes, ctx.userId ?? null]
  );
  const periodId = Number(ins.rows[0].id);
  await logAudit(c, ctx, {
    action: 'attendance.period.created',
    resource: 'attendance_periods',
    recordId: periodId,
    recordCode: code,
    newValues: { periodName: name, startDate, endDate, branchId: scope.branchId, notes },
  });
  return { period: await fetchPeriod(c, scope, periodId) };
}

async function transitionPeriod(
  c: pg.PoolClient,
  ctx: Ctx,
  periodId: number,
  body: Record<string, unknown>,
  allowedFrom: string[],
  to: string,
  action: string,
  reasonLabel: string
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const period = await fetchPeriod(c, scope, periodId);
  const from = String(period.status);
  if (!allowedFrom.includes(from)) throw badRequest(`Period cannot move from ${from} to ${to}`);
  const reason = cleanStr(body.reason, 500);
  const sets = [`status = '${to}'`, 'updated_at = now()'];
  const setParams: unknown[] = [];
  if (to === 'PENDING_APPROVAL') { sets.push(`submitted_by = $${setParams.length + 1}`, 'submitted_at = now()'); setParams.push(ctx.userId ?? null); }
  if (to === 'APPROVED') { sets.push(`approved_by = $${setParams.length + 1}`, 'approved_at = now()'); setParams.push(ctx.userId ?? null); }
  if (to === 'LOCKED') { sets.push(`locked_by = $${setParams.length + 1}`, 'locked_at = now()'); setParams.push(ctx.userId ?? null); }
  if (reason) { sets.push(`notes = COALESCE(notes, '') || E'\\n' || $${setParams.length + 1}`); setParams.push(reason); }
  const params = [...setParams, scope.tenantId, periodId];
  const upd = await c.query(
    `UPDATE attendance_periods SET ${sets.join(', ')}
      WHERE tenant_id = $${params.length - 1} AND id = $${params.length}
      RETURNING id, status`,
    params
  );
  const newStatus = upd.rows.length > 0 ? String(upd.rows[0].status) : to;
  await logAudit(c, ctx, {
    action,
    resource: 'attendance_periods',
    recordId: periodId,
    recordCode: String(period.period_code ?? ''),
    oldValues: { status: from },
    newValues: { status: newStatus, reason },
    metadata: { transition: `${from}->${to}` },
  });
  return { id: periodId, periodCode: period.period_code, fromStatus: from, status: newStatus, reason: reason ?? reasonLabel };
}

export function submitAttendancePeriod(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  return transitionPeriod(c, ctx, id, {}, ['OPEN'], 'PENDING_APPROVAL', 'attendance.period.submitted', 'Submitted for approval');
}

export async function approveAttendancePeriod(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const result = await transitionPeriod(c, ctx, id, body, ['PENDING_APPROVAL', 'APPROVED'], 'APPROVED', 'attendance.period.approved', 'Period approved');
  const upd = await c.query(
    `UPDATE attendance_records
        SET approval_status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now()
      WHERE period_id = $2 AND tenant_id = $3 AND approval_status IN ('DRAFT', 'SUBMITTED')`,
    [ctx.userId ?? null, id, scope.tenantId]
  );
  result.approvedRecords = upd.rowCount ?? 0;
  return result;
}/** Payroll gate: lock an APPROVED period and record the lock event. */
export async function lockAttendancePeriod(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const period = await fetchPeriod(c, scope, id);
  const from = String(period.status);
  if (from !== 'APPROVED') throw badRequest('Only an APPROVED period can be locked for payroll');
  const reason = cleanStr(body.reason, 500);
  const reasonLabel = reason ?? 'Locked for payroll processing';
  const upd = await c.query(
    `UPDATE attendance_periods
        SET status = 'LOCKED', locked_by = $1, locked_at = now(), updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, status`,
    [ctx.userId ?? null, id, scope.tenantId]
  );
  if (upd.rows.length === 0) throw notFound('Attendance period not found');
  const openRecords = await c.query(
    `SELECT count(*)::int AS n FROM attendance_records
      WHERE period_id = $1 AND tenant_id = $2 AND approval_status NOT IN ('APPROVED', 'REJECTED', 'ADJUSTED')`,
    [id, scope.tenantId]
  );
  await c.query(
    `INSERT INTO attendance_period_locks
       (tenant_id, company_id, period_id, action, from_status, to_status, performed_by, reason, metadata)
     VALUES ($1,$2,$3,'LOCK',$4,'LOCKED',$5,$6,$7)`,
    [
      scope.tenantId,
      Number(period.company_id),
      id,
      from,
      ctx.userId ?? null,
      reasonLabel,
      JSON.stringify({ unapprovedRecords: Number(openRecords.rows[0]?.n ?? 0) }),
    ]
  );
  await logAudit(c, ctx, {
    action: 'attendance.period.locked',
    resource: 'attendance_periods',
    recordId: id,
    recordCode: String(period.period_code ?? ''),
    oldValues: { status: from },
    newValues: { status: 'LOCKED', reason: reasonLabel, unapprovedRecords: Number(openRecords.rows[0]?.n ?? 0) },
  });
  return { id, periodCode: period.period_code, fromStatus: from, status: 'LOCKED', reason: reasonLabel };
}

/** Reopen a LOCKED period (recorded in attendance_period_locks as UNLOCK). */
export async function reopenAttendancePeriod(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const period = await fetchPeriod(c, scope, id);
  const from = String(period.status);
  if (from !== 'LOCKED') throw badRequest('Only a LOCKED period can be reopened');
  const reason = cleanStr(body.reason, 500) ?? 'Reopened by administrator';
  await c.query(
    `UPDATE attendance_periods SET status = 'APPROVED', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [id, scope.tenantId]
  );
  await c.query(
    `INSERT INTO attendance_period_locks
       (tenant_id, company_id, period_id, action, from_status, to_status, performed_by, reason)
     VALUES ($1,$2,$3,'UNLOCK',$4,'APPROVED',$5,$6)`,
    [scope.tenantId, Number(period.company_id), id, from, ctx.userId ?? null, reason]
  );
  await logAudit(c, ctx, {
    action: 'attendance.period.reopened',
    resource: 'attendance_periods',
    recordId: id,
    recordCode: String(period.period_code ?? ''),
    oldValues: { status: from },
    newValues: { status: 'APPROVED', reason },
  });
  return { id, periodCode: period.period_code, fromStatus: from, status: 'APPROVED', reason };
}

// ---- Manual adjustments -----------------------------------------------------
const ISO = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const isoOf = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v !== null && v !== undefined ? String(v) : null);

const ADJ_TIME_COLS = ['check_in', 'check_out', 'break_start', 'break_end'];

/** Whitelist + validate the mutable fields of an attendance record. */
function sanitizeAdjustment(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ADJ_TIME_COLS) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { out[key] = null; continue; }
    const iso = ISO(body[key]);
    if (iso === null) throw badRequest(`Invalid ${key} timestamp`);
    out[key] = iso;
  }
  if (body.attendance_status !== undefined) {
    const st = cleanStr(body.attendance_status, 24);
    if (!st || !STATUSES.includes(st)) throw badRequest('Invalid attendance status');
    out.attendance_status = st;
  }
  if (body.notes !== undefined) {
    const n = body.notes === null || body.notes === '' ? null : cleanStr(body.notes, 2000);
    out.notes = n;
  }
  return out;
}

async function fetchAdjustment(c: pg.PoolClient, scope: OrgScope, id: number): Promise<Record<string, unknown>> {
  const conds: string[] = ['ad.tenant_id = $1', 'ad.id = $2'];
  const params: unknown[] = [scope.tenantId, id];
  if (scope.companyId !== null) { params.push(scope.companyId); conds.push(`ad.company_id = $${params.length}`); }
  if (scope.branchId !== null) { params.push(scope.branchId); conds.push(`COALESCE(e.branch_id, r.branch_id) = $${params.length}`); }
  const res = await c.query(
    `SELECT ad.*, e.employee_no, e.first_name, e.last_name
       FROM attendance_adjustments ad
       JOIN employees e ON e.id = ad.employee_id
       LEFT JOIN attendance_records r ON r.id = ad.attendance_record_id
      WHERE ${conds.join(' AND ')}`,
    params
  );
  if (res.rows.length === 0) throw notFound('Adjustment not found');
  return res.rows[0] as unknown as Record<string, unknown>;
}

/** Request a manual adjustment. Requires a reason and never touches LOCKED periods. */
export async function createAttendanceAdjustment(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const employeeId = cleanInt(body.employeeId);
  if (employeeId === null) throw badRequest('employeeId is required');
  const reason = cleanStr(body.reason, 1000);
  if (!reason) throw badRequest('A reason is required for an attendance adjustment');

  let record: Record<string, unknown> | null = null;
  const recordId = cleanInt(body.attendanceRecordId);
  if (recordId !== null) {
    record = await fetchScopedRecord(c, scope, recordId);
    if (Number(record.employee_id) !== employeeId) throw badRequest('attendanceRecordId does not belong to employeeId');
  } else {
    const workDate = cleanDate(body.workDate);
    if (!workDate) throw badRequest('Provide attendanceRecordId or workDate');
    const findParams: unknown[] = [scope.tenantId];
    const companyCond = scope.companyId !== null ? `AND a.company_id = $${findParams.length + 1}` : '';
    if (scope.companyId !== null) findParams.push(scope.companyId);
    findParams.push(employeeId, workDate);
    const found = await c.query(
      `SELECT a.id FROM attendance_records a
        WHERE a.tenant_id = $1 AND a.employee_id = $${findParams.length - 1} AND a.work_date = $${findParams.length}::date ${companyCond}
        ORDER BY (a.shift_id IS NULL), a.id LIMIT 1`,
      findParams
    );
    if (found.rows.length === 0) throw notFound('No attendance record for the employee on that date');
    record = await fetchScopedRecord(c, scope, Number(found.rows[0].id));
  }
  const rec = record as Record<string, unknown>;
  const periodStatus = rec.period_status;
  if (periodStatus === 'LOCKED') throw badRequest('Attendance is LOCKED for payroll and cannot be adjusted');

  const newValues = sanitizeAdjustment(body);
  const keys = Object.keys(newValues);
  if (keys.length === 0) throw badRequest('Provide at least one adjustable value (check-in/out, break, status or notes)');
  const previousValues: Record<string, unknown> = {};
  for (const key of [...ADJ_TIME_COLS, 'attendance_status', 'notes']) {
    if (newValues[key] !== undefined) previousValues[key] = rec[key] ?? null;
  }

  const ins = await c.query(
    `INSERT INTO attendance_adjustments
       (tenant_id, company_id, employee_id, attendance_record_id, adjustment_type,
        previous_values, new_values, reason, status, requested_by)
     VALUES ($1,$2,$3,$4,'MANUAL',$5,$6,$7,'PENDING',$8)
     RETURNING id`,
    [
      scope.tenantId, Number(rec.company_id), employeeId, Number(rec.id),
      JSON.stringify(previousValues), JSON.stringify(newValues), reason, ctx.userId ?? null,
    ]
  );
  const adjustmentId = Number(ins.rows[0].id);
  await logAudit(c, ctx, {
    action: 'attendance.adjustment.requested',
    resource: 'attendance_adjustments',
    recordId: adjustmentId,
    recordCode: `${String(rec.employee_no ?? '')}:${String(rec.work_date ?? '')}`,
    oldValues: previousValues,
    newValues,
    metadata: { attendanceRecordId: Number(rec.id), reason },
  });
  return { adjustment: await fetchAdjustment(c, scope, adjustmentId) };
}

/** Approve an adjustment: recompute metrics and apply it to the record. */
export async function approveAttendanceAdjustment(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const adj = await fetchAdjustment(c, scope, id);
  if (String(adj.status) !== 'PENDING') throw badRequest('Only a PENDING adjustment can be approved');
  const newValues = (adj.new_values ?? {}) as Record<string, unknown>;

  if (adj.attendance_record_id != null) {
    const rec = await fetchScopedRecord(c, scope, Number(adj.attendance_record_id));
    if (String(rec.period_status) === 'LOCKED') throw badRequest('Attendance is LOCKED for payroll and cannot be adjusted');

    const finalIn = 'check_in' in newValues ? isoOf(newValues.check_in) : isoOf(rec.check_in);
    const finalOut = 'check_out' in newValues ? isoOf(newValues.check_out) : isoOf(rec.check_out);
    const finalBreakStart = 'break_start' in newValues ? isoOf(newValues.break_start) : isoOf(rec.break_start);
    const finalBreakEnd = 'break_end' in newValues ? isoOf(newValues.break_end) : isoOf(rec.break_end);
    const metrics = computeMetrics({
      startTime: null,
      endTime: null,
      graceMinutes: Number(rec.grace_minutes ?? 0),
      breakMinutes: Number(rec.break_minutes ?? 0),
      scheduledStartIso: isoOf(rec.scheduled_start),
      scheduledEndIso: isoOf(rec.scheduled_end),
      checkInIso: finalIn,
      checkOutIso: finalOut,
      breakStartIso: finalBreakStart,
      breakEndIso: finalBreakEnd,
    });
    const finalStatus = 'attendance_status' in newValues ? newValues.attendance_status : metrics.attendanceStatus;
    const finalNotes = 'notes' in newValues ? newValues.notes : isoOf(rec.notes);
    const setCols = ['check_in', 'check_out', 'break_start', 'break_end', 'attendance_status', 'notes'];
    const setParams: unknown[] = [];
    for (const col of setCols) {
      setParams.push(col === 'attendance_status' ? finalStatus : col === 'notes' ? finalNotes : newValues[col] !== undefined ? newValues[col] : rec[col]);
    }
    setParams.push(
      metrics.scheduledMinutes, metrics.workedMinutes, metrics.actualMinutes,
      metrics.lateMinutes, metrics.earlyDepartureMinutes, metrics.overtimeMinutes, metrics.undertimeMinutes,
      ctx.userId ?? null, ctx.userId ?? null, Number(rec.id)
    );
    await c.query(
      `UPDATE attendance_records
          SET check_in = $1::timestamptz, check_out = $2::timestamptz,
              break_start = $3::timestamptz, break_end = $4::timestamptz,
              attendance_status = $5, notes = $6,
              scheduled_minutes = $7, worked_minutes = $8, actual_minutes = $9,
              late_minutes = $10, early_departure_minutes = $11,
              overtime_minutes = $12, undertime_minutes = $13,
              approval_status = 'ADJUSTED',
              reviewed_by = $14, reviewed_at = now(), approved_by = $15, approved_at = now(),
              updated_at = now()
        WHERE id = $16`,
      setParams
    );
  }
  await c.query(
    `UPDATE attendance_adjustments
        SET status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [ctx.userId ?? null, id, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.adjustment.approved',
    resource: 'attendance_adjustments',
    recordId: id,
    oldValues: { status: 'PENDING' },
    newValues: { status: 'APPROVED', applied: newValues },
  });
  return { adjustment: await fetchAdjustment(c, scope, id) };
}

/** Reject an adjustment (record untouched). */
export async function rejectAttendanceAdjustment(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const adj = await fetchAdjustment(c, scope, id);
  if (String(adj.status) !== 'PENDING') throw badRequest('Only a PENDING adjustment can be rejected');
  const reason = cleanStr(body.reason, 500) ?? 'Rejected by approver';
  await c.query(
    `UPDATE attendance_adjustments SET status = 'REJECTED', updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [id, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.adjustment.rejected',
    resource: 'attendance_adjustments',
    recordId: id,
    oldValues: { status: 'PENDING' },
    newValues: { status: 'REJECTED' },
    metadata: { reason },
  });
  return { id, status: 'REJECTED', reason };
}

/** Adjustment centre (org-scoped list). */
export async function listAttendanceAdjustments(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const conds: string[] = ['ad.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) { params.push(scope.companyId); conds.push(`ad.company_id = $${params.length}`); }
  if (scope.branchId !== null) { params.push(scope.branchId); conds.push(`COALESCE(e.branch_id, r.branch_id) = $${params.length}`); }
  const status = cleanStr(q.status, 16);
  if (status) {
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) throw badRequest('Invalid adjustment status');
    params.push(status); conds.push(`ad.status = $${params.length}`);
  }
  const employeeId = cleanInt(q.employeeId);
  if (employeeId !== null) { params.push(employeeId); conds.push(`ad.employee_id = $${params.length}`); }
  const pg = pageOf(q);
  const where = conds.join(' AND ');
  const totalRes = await c.query(
    `SELECT count(*)::int AS total
       FROM attendance_adjustments ad
       JOIN employees e ON e.id = ad.employee_id
       LEFT JOIN attendance_records r ON r.id = ad.attendance_record_id
      WHERE ${where}`,
    params
  );
  const rowsRes = await c.query(
    `SELECT ad.*, e.employee_no, e.first_name, e.last_name, r.work_date, r.period_id
       FROM attendance_adjustments ad
       JOIN employees e ON e.id = ad.employee_id
       LEFT JOIN attendance_records r ON r.id = ad.attendance_record_id
      WHERE ${where}
      ORDER BY ad.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pg.pageSize, pg.offset]
  );
  return {
    items: rowsRes.rows.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      return {
        id: Number(x.id),
        employeeId: Number(x.employee_id),
        employee: { id: Number(x.employee_id), employeeNo: x.employee_no, name: `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() },
        attendanceRecordId: x.attendance_record_id != null ? Number(x.attendance_record_id) : null,
        workDate: x.work_date,
        periodId: x.period_id != null ? Number(x.period_id) : null,
        adjustmentType: x.adjustment_type,
        previousValues: x.previous_values,
        newValues: x.new_values,
        reason: x.reason,
        status: x.status,
        requestedBy: x.requested_by != null ? Number(x.requested_by) : null,
        approvedBy: x.approved_by != null ? Number(x.approved_by) : null,
        approvedAt: x.approved_at,
        createdAt: x.created_at,
        updatedAt: x.updated_at,
      };
    }),
    total: Number(totalRes.rows[0]?.total ?? 0),
    page: pg.page,
    pageSize: pg.pageSize,
  };
}