/**
 * Hikvision events administration: raw journal, event detail, retry,
 * reprocess, reject and the failed-event centre. Every action is scoped to
 * the caller's tenant/company/branch and audited. Raw rows are never deleted;
 * administrative actions only move them between processing states.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../utils.js';
import { logAudit } from '../audit.js';
import { cleanInt, cleanStr, resolveOrg, OrgScope } from './adminCommon.js';

export const HIK_RAW_STATUSES = [
  'RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'DUPLICATE', 'FAILED', 'REJECTED',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** hikvision_raw_events has no branch column: tenant/company always apply and
 *  a branch-bound caller is confined through the joined device row. */
function rawScopeClause(scope: OrgScope): { clause: string; params: unknown[] } {
  const conds: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`r.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`d.branch_id = $${params.length}`);
  }
  return { clause: conds.join(' AND '), params };
}

function cleanDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

interface PageArgs { page: number; pageSize: number; offset: number }
function pageOf(q: Record<string, unknown>): PageArgs {
  const page = Math.max(1, cleanInt(q.page, 1_000_000, 1) ?? 1);
  const pageSize = Math.min(200, cleanInt(q.pageSize, 200, 1) ?? 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const EVENT_LIST_SQL = `
  SELECT r.id, r.tenant_id, r.company_id, r.device_id, r.device_serial_number,
         r.payload_format, r.received_at, r.device_event_time, r.event_type,
         r.source_ip, r.processing_status, r.retry_count, r.last_error,
         r.error_message, r.duplicate_of_raw_event_id, r.dedupe_key,
         r.created_at, r.updated_at,
         d.code AS device_code, d.name AS device_name, d.physical_location AS device_location,
         d.device_purpose AS device_purpose,
         n.employee_identifier, n.employee_id, n.event_type AS normalized_type,
         n.verification_method,
         e.employee_no, e.first_name, e.last_name
    FROM hikvision_raw_events r
    JOIN hikvision_devices d ON d.id = r.device_id
    LEFT JOIN hikvision_normalized_events n ON n.raw_event_id = r.id
    LEFT JOIN employees e ON e.id = n.employee_id`;

function mapEventRow(row: Record<string, unknown>): Record<string, unknown> {
  const employeeId = row.employee_id != null ? Number(row.employee_id) : null;
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    companyId: Number(row.company_id),
    deviceId: row.device_id != null ? Number(row.device_id) : null,
    deviceSerialNumber: row.device_serial_number,
    device: row.device_id != null
      ? { id: Number(row.device_id), code: row.device_code, name: row.device_name, location: row.device_location, purpose: row.device_purpose }
      : null,
    payloadFormat: row.payload_format,
    receivedAt: row.received_at,
    deviceEventTime: row.device_event_time,
    eventType: row.event_type,
    normalizedType: row.normalized_type ?? null,
    verificationMethod: row.verification_method ?? null,
    employeeIdentifier: row.employee_identifier ?? null,
    employee: employeeId !== null
      ? { id: employeeId, employeeNo: row.employee_no, name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() }
      : null,
    sourceIp: row.source_ip,
    processingStatus: row.processing_status,
    retryCount: Number(row.retry_count ?? 0),
    lastError: row.last_error,
    errorMessage: row.error_message,
    duplicateOfRawEventId: row.duplicate_of_raw_event_id != null ? Number(row.duplicate_of_raw_event_id) : null,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Events list (raw journal). Optional filters: status/format/device/serial/text/date range. */
export async function listRawEvents(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const scoped = rawScopeClause(scope);
  const conds = [scoped.clause];
  const params: unknown[] = [...scoped.params];

  const status = cleanStr(q.status, 24);
  if (status) {
    if (!(HIK_RAW_STATUSES as readonly string[]).includes(status)) throw badRequest('Invalid processing status filter');
    params.push(status);
    conds.push(`r.processing_status = $${params.length}`);
  }
  const format = cleanStr(q.format, 16);
  if (format) {
    params.push(format.toUpperCase());
    conds.push(`r.payload_format = $${params.length}`);
  }
  const deviceId = q.deviceId !== undefined ? cleanInt(q.deviceId) : null;
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push(`r.device_id = $${params.length}`);
  }
  const serial = cleanStr(q.serial, 64);
  if (serial) {
    params.push(serial);
    conds.push(`d.serial_number = $${params.length}`);
  }
  const employeeIdentifier = cleanStr(q.employeeIdentifier, 128);
  if (employeeIdentifier) {
    params.push(employeeIdentifier);
    conds.push(`n.employee_identifier = $${params.length}`);
  }
  const dateFrom = cleanDate(q.dateFrom ?? q.from);
  if (dateFrom) {
    params.push(dateFrom);
    conds.push(`r.created_at >= $${params.length}::date`);
  }
  const dateTo = cleanDate(q.dateTo ?? q.to);
  if (dateTo) {
    params.push(dateTo);
    conds.push(`r.created_at < ($${params.length}::date + interval '1 day')`);
  }
  const text = cleanStr(q.q, 120);
  if (text) {
    params.push(`%${text}%`);
    conds.push(`(d.name ILIKE $${params.length} OR d.serial_number ILIKE $${params.length} OR r.device_serial_number ILIKE $${params.length} OR COALESCE(n.employee_identifier,'') ILIKE $${params.length} OR COALESCE(e.employee_no,'') ILIKE $${params.length} OR COALESCE(e.first_name || ' ' || e.last_name,'') ILIKE $${params.length})`);
  }

  const where = conds.join(' AND ');
  const { page, pageSize, offset } = pageOf(q);
  const countRes = await c.query(`SELECT count(*)::int AS total FROM hikvision_raw_events r JOIN hikvision_devices d ON d.id = r.device_id LEFT JOIN hikvision_normalized_events n ON n.raw_event_id = r.id LEFT JOIN employees e ON e.id = n.employee_id WHERE ${where}`, params);
  const total = Number(countRes.rows[0]?.total ?? 0);
  const listRes = await c.query(
    `${EVENT_LIST_SQL} WHERE ${where} ORDER BY r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  return {
    items: (listRes.rows as unknown as Record<string, unknown>[]).map(mapEventRow),
    total,
    page,
    pageSize,
  };
}

/** Failed events centre: convenience view over the raw journal for FAILED rows. */
export async function listFailedEvents(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  return listRawEvents(c, ctx, { ...q, status: 'FAILED' });
}

async function fetchRawEvent(c: pg.PoolClient, scope: OrgScope, id: number): Promise<Record<string, unknown>> {
  const scoped = rawScopeClause(scope);
  const res = await c.query(
    `${EVENT_LIST_SQL} WHERE r.id = $${scoped.params.length + 1} AND ${scoped.clause}`,
    [...scoped.params, id]
  );
  if (res.rows.length === 0) throw notFound('Event not found');
  return res.rows[0] as unknown as Record<string, unknown>;
}

/** Full event detail: raw row, payload, canonical event, punches, exceptions, errors, audit history. */
export async function getRawEventDetail(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const raw = await fetchRawEvent(c, scope, id);
  const rawId = Number(raw.id);

  const payloadRes = await c.query(
    'SELECT payload FROM hikvision_raw_events WHERE id = $1 AND tenant_id = $2',
    [rawId, scope.tenantId]
  );
  const normalizedRes = await c.query(
    `SELECT * FROM hikvision_normalized_events WHERE raw_event_id = $1 AND tenant_id = $2`,
    [rawId, scope.tenantId]
  );
  const punchesRes = await c.query(
    `SELECT id, punch_time, punch_type, verification_method, device_purpose, location,
            segment, attendance_record_id, metadata, created_at
       FROM attendance_punch_events
      WHERE raw_event_id = $1 AND tenant_id = $2
      ORDER BY punch_time`,
    [rawId, scope.tenantId]
  );
  const exceptionsRes = await c.query(
    `SELECT id, exception_type, severity, status, employee_identifier, event_time,
            summary, resolution, assigned_to, created_at
       FROM attendance_exceptions
      WHERE raw_event_id = $1 AND tenant_id = $2
      ORDER BY id DESC`,
    [rawId, scope.tenantId]
  );
  const errorsRes = await c.query(
    `SELECT id, stage, error_code, error_message, created_at, resolved, resolved_at
       FROM hikvision_integration_errors
      WHERE raw_event_id = $1 AND tenant_id = $2
      ORDER BY id DESC`,
    [rawId, scope.tenantId]
  );
  const auditRes = await c.query(
    `SELECT action, user_id, record_id, old_values, new_values, metadata, ip, created_at
       FROM audit_logs
      WHERE resource = 'hikvision_raw_events' AND record_id = $1 AND tenant_id = $2
      ORDER BY id DESC LIMIT 50`,
    [rawId, scope.tenantId]
  );

  return {
    event: mapEventRow(raw),
    payload: (payloadRes.rows[0]?.payload as Record<string, unknown>) ?? null,
    normalized: normalizedRes.rows[0] ?? null,
    punches: punchesRes.rows,
    exceptions: exceptionsRes.rows,
    integrationErrors: errorsRes.rows,
    auditHistory: auditRes.rows,
  };
}

/** Requeue a FAILED/RECEIVED/REJECTED/DUPLICATE/PROCESSED event for the worker. */
export async function retryRawEvent(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const raw = await fetchRawEvent(c, scope, id);
  const rawId = Number(raw.id);
  const status = String(raw.processing_status);
  if (status === 'PROCESSING') throw badRequest('Event is currently being processed');
  await c.query(
    `UPDATE hikvision_raw_events
        SET processing_status = 'QUEUED', error_message = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [rawId, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.event.retry',
    resource: 'hikvision_raw_events',
    recordId: rawId,
    recordCode: String(raw.device_serial_number ?? ''),
    oldValues: { processingStatus: status },
    newValues: { processingStatus: 'QUEUED' },
    metadata: { deviceId: raw.device_id != null ? Number(raw.device_id) : null },
  });
  return mapEventRow(raw);
}

/** Full reprocess: requeue and drop duplicate markers so the event is re-evaluated. */
export async function reprocessRawEvent(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const raw = await fetchRawEvent(c, scope, id);
  const rawId = Number(raw.id);
  const status = String(raw.processing_status);
  if (status === 'PROCESSING') throw badRequest('Event is currently being processed');
  await c.query(
    `UPDATE hikvision_raw_events
        SET processing_status = 'QUEUED',
            duplicate_of_raw_event_id = NULL,
            error_message = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [rawId, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.event.reprocess',
    resource: 'hikvision_raw_events',
    recordId: rawId,
    recordCode: String(raw.device_serial_number ?? ''),
    oldValues: { processingStatus: status, duplicateOfRawEventId: raw.duplicate_of_raw_event_id },
    newValues: { processingStatus: 'QUEUED', duplicateOfRawEventId: null },
    metadata: { deviceId: raw.device_id != null ? Number(raw.device_id) : null },
  });
  return mapEventRow(raw);
}

/** Reject an event (kept in the journal, never deleted). */
export async function rejectRawEvent(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const raw = await fetchRawEvent(c, scope, id);
  const rawId = Number(raw.id);
  const status = String(raw.processing_status);
  if (status === 'PROCESSING') throw badRequest('Event is currently being processed');
  const reason = cleanStr(body.reason, 500);
  if (!reason) throw badRequest('A rejection reason is required');
  await c.query(
    `UPDATE hikvision_raw_events
        SET processing_status = 'REJECTED', error_message = $2, last_error = 'REJECTED_BY_ADMIN', updated_at = now()
      WHERE id = $1 AND tenant_id = $3`,
    [rawId, reason.slice(0, 2000), scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.event.reject',
    resource: 'hikvision_raw_events',
    recordId: rawId,
    recordCode: String(raw.device_serial_number ?? ''),
    oldValues: { processingStatus: status },
    newValues: { processingStatus: 'REJECTED', reason },
    metadata: { deviceId: raw.device_id != null ? Number(raw.device_id) : null },
  });
  return mapEventRow(raw);
}