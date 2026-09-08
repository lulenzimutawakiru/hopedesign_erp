/**
 * Attendance exception centre. Review/assign/resolve/approve/reject flows and
 * the UNKNOWN_EMPLOYEE mapping workflow. Mapping an unknown identifier to an
 * ERP employee never creates HR records: it writes an explicit
 * hikvision_employee_links row, back-fills the canonical normalized event and
 * re-queues the preserved raw event for a fresh pass through the engine.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../utils.js';
import { logAudit } from '../audit.js';
import { cleanInt, cleanStr, resolveOrg, scopeWhere, OrgScope } from './adminCommon.js';

export const HIK_EXCEPTION_STATUSES = ['OPEN', 'ASSIGNED', 'REVIEWING', 'RESOLVED', 'APPROVED', 'REJECTED'] as const;
export const HIK_EXCEPTION_TYPES = [
  'UNKNOWN_EMPLOYEE', 'UNMAPPED_DEVICE', 'DUPLICATE_PUNCH', 'MISSING_CHECK_IN',
  'MISSING_CHECK_OUT', 'LATE_ARRIVAL', 'EARLY_DEPARTURE', 'DEVICE_OFFLINE',
  'INVALID_TIMESTAMP', 'REPLAY_EVENT', 'SHIFT_CONFLICT', 'PERIOD_LOCKED', 'OTHER',
] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

function pageOf(q: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, cleanInt(q.page, 1_000_000, 1) ?? 1);
  const pageSize = Math.min(200, cleanInt(q.pageSize, 200, 1) ?? 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const EXCEPTION_SQL = `
  SELECT x.id, x.tenant_id, x.company_id, x.branch_id, x.employee_id,
         x.device_id, x.raw_event_id, x.attendance_record_id,
         x.exception_type, x.severity, x.status, x.employee_identifier,
         x.event_time, x.summary, x.resolution, x.assigned_to, x.assigned_at,
         x.resolved_by, x.resolved_at, x.reviewed_by, x.reviewed_at, x.created_at, x.updated_at,
         d.code AS device_code, d.name AS device_name,
         d.physical_location AS device_location, d.serial_number AS device_serial_number,
         e.employee_no, e.first_name, e.last_name, e.department_id,
         dp.name AS department_name,
         a.first_name AS assignee_first, a.last_name AS assignee_last,
         rb.first_name AS resolved_first, rb.last_name AS resolved_last
    FROM attendance_exceptions x
    LEFT JOIN hikvision_devices d ON d.id = x.device_id
    LEFT JOIN employees e ON e.id = x.employee_id
    LEFT JOIN departments dp ON dp.id = e.department_id
    LEFT JOIN users a ON a.id = x.assigned_to
    LEFT JOIN users rb ON rb.id = x.resolved_by`;

function mapExceptionRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id),
    branchId: row.branch_id != null ? Number(row.branch_id) : null,
    employeeId: row.employee_id != null ? Number(row.employee_id) : null,
    deviceId: row.device_id != null ? Number(row.device_id) : null,
    rawEventId: row.raw_event_id != null ? Number(row.raw_event_id) : null,
    attendanceRecordId: row.attendance_record_id != null ? Number(row.attendance_record_id) : null,
    exceptionType: row.exception_type,
    severity: row.severity,
    status: row.status,
    employeeIdentifier: row.employee_identifier,
    eventTime: row.event_time,
    summary: row.summary,
    resolution: row.resolution,
    assignedTo: row.assigned_to != null ? Number(row.assigned_to) : null,
    assignedAt: row.assigned_at,
    resolvedBy: row.resolved_by != null ? Number(row.resolved_by) : null,
    resolvedAt: row.resolved_at,
    reviewedBy: row.reviewed_by != null ? Number(row.reviewed_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    device: row.device_id != null
      ? { id: Number(row.device_id), code: row.device_code, name: row.device_name, location: row.device_location, serialNumber: row.device_serial_number }
      : null,
    employee: row.employee_id != null
      ? { id: Number(row.employee_id), employeeNo: row.employee_no, name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(), departmentId: row.department_id != null ? Number(row.department_id) : null, departmentName: row.department_name }
      : null,
    assignee: row.assigned_to != null ? { id: Number(row.assigned_to), name: `${row.assignee_first ?? ''} ${row.assignee_last ?? ''}`.trim() } : null,
    resolvedByName: row.resolved_by != null ? `${row.resolved_first ?? ''} ${row.resolved_last ?? ''}`.trim() : null,
  };
}

/** List exceptions within scope with filters. */
export async function listExceptions(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const scoped = scopeWhere(scope, 'x');
  const conds = [scoped.clause];
  const params: unknown[] = [...scoped.params];

  const status = cleanStr(q.status, 24);
  if (status) {
    if (!(HIK_EXCEPTION_STATUSES as readonly string[]).includes(status)) throw badRequest('Invalid exception status filter');
    params.push(status);
    conds.push(`x.status = $${params.length}`);
  }
  const type = cleanStr(q.exceptionType ?? q.type, 40);
  if (type) {
    if (!(HIK_EXCEPTION_TYPES as readonly string[]).includes(type)) throw badRequest('Invalid exception type filter');
    params.push(type);
    conds.push(`x.exception_type = $${params.length}`);
  }
  const severity = cleanStr(q.severity, 12);
  if (severity) {
    params.push(severity.toUpperCase());
    conds.push(`x.severity = $${params.length}`);
  }
  const deviceId = q.deviceId !== undefined ? cleanInt(q.deviceId) : null;
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push(`x.device_id = $${params.length}`);
  }
  const employeeId = q.employeeId !== undefined ? cleanInt(q.employeeId) : null;
  if (employeeId !== null) {
    params.push(employeeId);
    conds.push(`x.employee_id = $${params.length}`);
  }
  const dateFrom = cleanDate(q.dateFrom ?? q.from);
  if (dateFrom) {
    params.push(dateFrom);
    conds.push(`COALESCE(x.event_time, x.created_at) >= $${params.length}::date`);
  }
  const dateTo = cleanDate(q.dateTo ?? q.to);
  if (dateTo) {
    params.push(dateTo);
    conds.push(`COALESCE(x.event_time, x.created_at) < ($${params.length}::date + interval '1 day')`);
  }
  const text = cleanStr(q.q, 120);
  if (text) {
    params.push(`%${text}%`);
    conds.push(`(x.summary ILIKE $${params.length} OR COALESCE(x.employee_identifier,'') ILIKE $${params.length} OR d.name ILIKE $${params.length} OR COALESCE(e.first_name || ' ' || e.last_name,'') ILIKE $${params.length} OR COALESCE(e.employee_no,'') ILIKE $${params.length})`);
  }

  const where = conds.join(' AND ');
  const { page, pageSize, offset } = pageOf(q);
  const countRes = await c.query(
    `SELECT count(*)::int AS total
       FROM attendance_exceptions x
       LEFT JOIN hikvision_devices d ON d.id = x.device_id
       LEFT JOIN employees e ON e.id = x.employee_id
      WHERE ${where}`,
    params
  );
  const total = Number(countRes.rows[0]?.total ?? 0);
  const listRes = await c.query(
    `${EXCEPTION_SQL} WHERE ${where} ORDER BY x.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  return { items: (listRes.rows as unknown as Record<string, unknown>[]).map(mapExceptionRow), total, page, pageSize };
}

async function fetchException(c: pg.PoolClient, scope: OrgScope, id: number): Promise<Record<string, unknown>> {
  const scoped = scopeWhere(scope, 'x');
  const res = await c.query(
    `${EXCEPTION_SQL} WHERE x.id = $${scoped.params.length + 1} AND ${scoped.clause}`,
    [...scoped.params, id]
  );
  if (res.rows.length === 0) throw notFound('Exception not found');
  return res.rows[0] as unknown as Record<string, unknown>;
}

/** Full exception detail incl. canonical event, related punches and audit trail. */
export async function getException(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const rawRes = await c.query(
    `SELECT r.id, r.payload_format, r.processing_status, r.device_event_time, r.received_at,
            r.error_message, r.duplicate_of_raw_event_id, r.payload
       FROM hikvision_raw_events r
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [row.raw_event_id, scope.tenantId]
  );
  const recordRes = await c.query(
    `SELECT id, work_date, shift_code, check_in, check_out, attendance_status,
            approval_status, late_minutes, overtime_minutes, worked_minutes
       FROM attendance_records
      WHERE id = $1 AND tenant_id = $2`,
    [row.attendance_record_id, scope.tenantId]
  );
  const auditRes = await c.query(
    `SELECT action, user_id, old_values, new_values, metadata, ip, created_at
       FROM audit_logs
      WHERE resource = 'attendance_exceptions' AND record_id = $1 AND tenant_id = $2
      ORDER BY id DESC LIMIT 50`,
    [xId, scope.tenantId]
  );
  return {
    exception: mapExceptionRow(row),
    rawEvent: rawRes.rows[0] ?? null,
    attendanceRecord: recordRes.rows[0] ?? null,
    auditHistory: auditRes.rows,
  };
}

async function requireAssignee(c: pg.PoolClient, scope: OrgScope, userId: number): Promise<void> {
  const res = await c.query('SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND status = $3', [userId, scope.tenantId, 'ACTIVE']);
  if (res.rows.length === 0) throw badRequest('Assignee is not an active user in your tenant');
}

export async function assignException(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const assigneeId = cleanInt(body.assignedToUserId ?? body.userId);
  if (assigneeId === null) throw badRequest('assignedToUserId is required');
  await requireAssignee(c, scope, assigneeId);
  const previous = { status: row.status, assignedTo: row.assigned_to ?? null };
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'ASSIGNED', assigned_to = $2, assigned_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $3`,
    [xId, assigneeId, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.exception.assigned',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: previous,
    newValues: { status: 'ASSIGNED', assignedTo: assigneeId },
    metadata: { exceptionType: row.exception_type },
  });
  return getException(c, ctx, xId);
}

export async function resolveException(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const status = String(row.status);
  if (status === 'APPROVED' || status === 'REJECTED') throw badRequest(`Cannot resolve a ${status} exception`);
  const resolution = cleanStr(body.resolution, 2000);
  if (!resolution) throw badRequest('A resolution note is required');
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'RESOLVED', resolution = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $4`,
    [xId, resolution, ctx.userId ?? null, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.exception.resolved',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: { status },
    newValues: { status: 'RESOLVED', resolution },
    metadata: { exceptionType: row.exception_type },
  });
  return getException(c, ctx, xId);
}

export async function approveException(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const status = String(row.status);
  if (status === 'APPROVED') return getException(c, ctx, xId);
  if (status === 'REJECTED') throw badRequest('A rejected exception must be reopened before approval');
  const resolution = cleanStr(body.resolution, 2000) ?? cleanStr(row.resolution, 2000) ?? 'Approved by reviewer';
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'APPROVED', resolution = $2,
            resolved_by = $3, resolved_at = now(),
            reviewed_by = $3, reviewed_at = now(),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $4`,
    [xId, resolution, ctx.userId ?? null, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.exception.approved',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: { status },
    newValues: { status: 'APPROVED', resolution },
    metadata: { exceptionType: row.exception_type },
  });
  return getException(c, ctx, xId);
}

export async function rejectException(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const status = String(row.status);
  if (status === 'APPROVED') throw badRequest('An approved exception must be reopened before rejection');
  const reason = cleanStr(body.reason ?? body.resolution, 2000);
  if (!reason) throw badRequest('A rejection reason is required');
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'REJECTED', resolution = $2,
            resolved_by = $3, resolved_at = now(),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $4`,
    [xId, reason, ctx.userId ?? null, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.exception.rejected',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: { status },
    newValues: { status: 'REJECTED', resolution: reason },
    metadata: { exceptionType: row.exception_type },
  });
  return getException(c, ctx, xId);
}

/** Reopen a resolved/approved/rejected exception for further review. */
export async function reopenException(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  const status = String(row.status);
  if (status === 'OPEN' || status === 'ASSIGNED' || status === 'REVIEWING') return getException(c, ctx, xId);
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'OPEN', resolution = NULL, resolved_by = NULL, resolved_at = NULL,
            reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [xId, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'attendance.exception.reopened',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: { status },
    newValues: { status: 'OPEN' },
    metadata: { exceptionType: row.exception_type },
  });
  return getException(c, ctx, xId);
}

/**
 * Map an UNKNOWN_EMPLOYEE exception to an ERP employee, then re-queue the
 * preserved raw event so the engine re-evaluates it with the new mapping.
 */
export async function mapUnknownEmployee(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchException(c, scope, id);
  const xId = Number(row.id);
  if (String(row.exception_type) !== 'UNKNOWN_EMPLOYEE') {
    throw badRequest('Only UNKNOWN_EMPLOYEE exceptions can be resolved by mapping an employee');
  }
  const identifier = cleanStr(row.employee_identifier, 128);
  if (!identifier) throw badRequest('Exception carries no employee identifier to map');
  const employeeId = cleanInt(body.employeeId);
  if (employeeId === null) throw badRequest('employeeId is required');
  const companyId = Number(row.company_id);

  const empRes = await c.query(
    `SELECT id, employee_no, first_name, last_name, company_id, status
       FROM employees
      WHERE id = $1 AND tenant_id = $2`,
    [employeeId, scope.tenantId]
  );
  if (empRes.rows.length === 0) throw notFound('Employee not found');
  const emp = empRes.rows[0] as unknown as Record<string, unknown>;
  if (Number(emp.company_id) !== companyId) throw forbidden('Employee does not belong to the exception company');

  // 1) Explicit link (device-specific wins; a global link also covers the event).
  const deviceId = row.device_id != null ? Number(row.device_id) : null;
  const linkParams: unknown[] = [scope.tenantId, companyId, employeeId, identifier];
  let deviceClause = 'device_id IS NULL';
  if (deviceId !== null) {
    linkParams.push(deviceId);
    deviceClause = `(device_id = $${linkParams.length} OR device_id IS NULL)`;
  }
  const existing = await c.query(
    `SELECT id FROM hikvision_employee_links
      WHERE tenant_id = $1 AND company_id = $2 AND employee_identifier = $4 AND ${deviceClause}
      ORDER BY (device_id IS NOT NULL) DESC LIMIT 1`,
    linkParams
  );
  let linkId: number;
  if (existing.rows.length > 0) {
    linkId = Number(existing.rows[0].id);
    await c.query(
      `UPDATE hikvision_employee_links
          SET employee_id = $1, status = 'ACTIVE', updated_by = $2, updated_at = now()
        WHERE id = $3`,
      [employeeId, ctx.userId ?? null, linkId]
    );
  } else {
    const ins = await c.query(
      `INSERT INTO hikvision_employee_links
         (tenant_id, company_id, employee_id, device_id, employee_identifier,
          verification_method, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8)
       RETURNING id`,
      [
        scope.tenantId, companyId, employeeId, deviceId, identifier,
        cleanStr(row.metadata ? ((row.metadata as Record<string, unknown>).verification as string) : null, 24) ?? 'UNKNOWN',
        `Mapped from UNKNOWN_EMPLOYEE exception ${xId}`, ctx.userId ?? null,
      ]
    );
    linkId = Number(ins.rows[0].id);
  }

  // 2) Back-fill the canonical event so the audit trail shows the real employee.
  const rawEventId = row.raw_event_id != null ? Number(row.raw_event_id) : null;
  let rawStatus: string | null = null;
  if (rawEventId !== null) {
    await c.query(
      `UPDATE hikvision_normalized_events
          SET employee_id = $2, employee_identifier = $3
        WHERE raw_event_id = $1 AND tenant_id = $4`,
      [rawEventId, employeeId, identifier, scope.tenantId]
    );
    // 3) Re-queue the raw event (ON CONFLICT guards make re-processing idempotent).
    const upd = await c.query(
      `UPDATE hikvision_raw_events
          SET processing_status = 'QUEUED',
              duplicate_of_raw_event_id = NULL,
              error_message = NULL,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND processing_status <> 'PROCESSING'
        RETURNING processing_status`,
      [rawEventId, scope.tenantId]
    );
    rawStatus = upd.rows.length > 0 ? String(upd.rows[0].processing_status) : 'PROCESSING_ACTIVE';
  }

  const summary = cleanStr(body.resolution, 2000) ??
    `Mapped ${identifier} to ${emp.employee_no} (${emp.first_name} ${emp.last_name}). Raw event re-queued.`;
  await c.query(
    `UPDATE attendance_exceptions
        SET status = 'APPROVED', resolution = $2,
            employee_id = $3,
            resolved_by = $4, resolved_at = now(),
            reviewed_by = $4, reviewed_at = now(),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $5`,
    [xId, summary, employeeId, ctx.userId ?? null, scope.tenantId]
  );

  await logAudit(c, ctx, {
    action: 'hikvision.employee_link.mapped',
    resource: 'hikvision_employee_links',
    recordId: linkId,
    recordCode: identifier,
    newValues: { employeeId, employeeNo: emp.employee_no, deviceId, rawEventId },
    metadata: { exceptionId: xId },
  });
  await logAudit(c, ctx, {
    action: 'attendance.exception.mapped',
    resource: 'attendance_exceptions',
    recordId: xId,
    oldValues: { status: row.status },
    newValues: { status: 'APPROVED', employeeId, employeeNo: emp.employee_no },
    metadata: { rawEventStatus: rawStatus },
  });

  return {
    exception: (await getException(c, ctx, xId)).exception,
    employeeLinkId: linkId,
    mappedEmployee: { id: Number(emp.id), employeeNo: emp.employee_no, name: `${emp.first_name} ${emp.last_name}`.trim() },
    rawEventRequeued: rawStatus,
  };
}

/** Employee search for the mapping workflow (never creates employees). */
export async function searchEmployeesForMapping(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown>
): Promise<{ items: Record<string, unknown>[] }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId });
  const text = cleanStr(q.q, 120);
  if (!text) return { items: [] };
  const conds: string[] = ['e.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`e.company_id = $${params.length}`);
  }
  params.push(`%${text}%`);
  conds.push(`(e.employee_no ILIKE $${params.length} OR e.employee_number ILIKE $${params.length} OR e.short_employee_number ILIKE $${params.length} OR COALESCE(e.first_name || ' ' || e.last_name,'') ILIKE $${params.length})`);
  params.push(25);
  const res = await c.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status,
            e.branch_id, e.department_id, e.company_id,
            b.name AS branch_name, dp.name AS department_name
       FROM employees e
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.employee_no
      LIMIT $${params.length}`,
    params
  );
  return {
    items: (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      employeeNo: r.employee_no,
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
      position: r.position,
      status: r.status,
      branchId: r.branch_id != null ? Number(r.branch_id) : null,
      branchName: r.branch_name,
      departmentId: r.department_id != null ? Number(r.department_id) : null,
      departmentName: r.department_name,
    })),
  };
}