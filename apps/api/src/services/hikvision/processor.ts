/**
 * Hikvision queue worker (background processor).
 *
 * Claims raw events via the SECURITY DEFINER bridge (hikvision_claim_raw_events)
 * so it can operate without an authenticated end-user context, then processes
 * each event inside its own transaction with app context applied manually.
 *
 * Per event:
 *   raw event -> device reload -> employee resolution -> shift evaluation ->
 *   punch classification -> attendance record upsert -> metrics -> exceptions
 *   -> normalized event -> PROCESSED.
 *
 * Nothing here can permanently lose an event: failures are recorded in
 * hikvision_integration_errors and the raw row is flipped to FAILED so an
 * administrator can investigate and retry from the event inbox.
 */
import pg from 'pg';
import { pool } from '../../db.js';
import { logAudit } from '../audit.js';
import { notifyRole } from '../notifications.js';
import { tzDateKey, zonedDateTimeToUtc, shiftWindow } from './time.js';
import {
  classifyPunch,
  classifyVerification,
  computeMetrics,
  isAttendancePunch,
  type PunchType,
  type VerificationMethod,
} from './calc.js';

/** Row returned by hikvision_claim_raw_events(). */
export interface ClaimedRawEvent {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  department_id: number | null;
  device_id: number | null;
  device_serial_number: string;
  raw_event_id: number;
  payload: Record<string, unknown>;
  payload_format: string;
  device_event_time: Date | string | null;
  event_type: string | null;
  source_ip: string | null;
  retry_count: number;
}

interface StoredPayload {
  format?: string;
  raw?: unknown;
  fields?: Record<string, unknown>;
  employee_identifier?: string | null;
  device_serial?: string | null;
  event_time?: string | null;
  event_type?: string | null;
  verification?: string | null;
  access_status?: string | null;
  attendance_status?: string | null;
  event_id?: string | null;
}

interface DeviceRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  department_id: number | null;
  code: string;
  name: string;
  model: string | null;
  serial_number: string;
  device_purpose: string;
  timezone: string;
  connection_status: string;
  facility: string | null;
  physical_location: string | null;
  attendance_enabled: boolean;
  access_events_enabled: boolean;
  duplicate_window_seconds: number;
  allow_future_minutes: number;
  allow_past_minutes: number;
  break_start: string | null;
  break_end: string | null;
  default_shift_code: string | null;
  clock_drift_warning_seconds: number;
  heartbeat_stale_seconds: number;
  notify_unknown_employee: boolean;
}

interface EmployeeRow {
  id: number;
  company_id: number;
  tenant_id: number;
  branch_id: number | null;
  department_id: number | null;
  employee_no: string;
  first_name: string;
  last_name: string;
  position: string | null;
  status: string;
}

interface ShiftRow {
  id: number;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  break_minutes: number;
  work_hours: number;
  status: string;
}

interface PeriodRow {
  id: number;
  status: string;
}

interface RecordRow {
  id: number;
  shift_id: number | null;
  shift_code: string | null;
  scheduled_start: Date | string | null;
  scheduled_end: Date | string | null;
  grace_minutes: number;
  break_minutes: number;
  check_in: Date | string | null;
  check_out: Date | string | null;
  break_start: Date | string | null;
  break_end: Date | string | null;
  attendance_status: string;
  approval_status: string;
  raw_punch_count: number;
}

const DEVICE_SQL = `
  SELECT d.id, d.tenant_id, d.company_id, d.branch_id, d.department_id,
         d.code, d.name, d.model, d.serial_number, d.device_purpose, d.timezone,
         d.connection_status, d.facility, d.physical_location,
         COALESCE(c.attendance_enabled, true)        AS attendance_enabled,
         COALESCE(c.access_events_enabled, true)     AS access_events_enabled,
         COALESCE(c.duplicate_window_seconds, 30)    AS duplicate_window_seconds,
         COALESCE(c.allow_future_minutes, 5)         AS allow_future_minutes,
         COALESCE(c.allow_past_minutes, 1440)        AS allow_past_minutes,
         COALESCE(c.notify_unknown_employee, true)   AS notify_unknown_employee,
         c.break_start, c.break_end, c.default_shift_code,
         COALESCE(c.clock_drift_warning_seconds, 120) AS clock_drift_warning_seconds,
         COALESCE(c.heartbeat_stale_seconds, 300)    AS heartbeat_stale_seconds
    FROM hikvision_devices d
    LEFT JOIN hikvision_device_configurations c ON c.device_id = d.id
   WHERE d.id = $1
   ORDER BY c.id DESC
   LIMIT 1
`;

const EXCEPTION_STATES_OPEN = "'OPEN','ASSIGNED','REVIEWING'";

const toIso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const errMsg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/** Manually replicate db.ts applyContext (worker has no req.ctx). */
async function applyWorkerContext(client: pg.PoolClient, row: ClaimedRawEvent): Promise<void> {
  await client.query('SELECT set_app_context($1,$2,$3,$4)', [
    row.tenant_id,
    row.company_id,
    row.branch_id ?? null,
    null,
  ]);
  await client.query('SELECT set_config($1,$2,true)', ['app.correlation_id', `hik-${row.raw_event_id}`]);
  await client.query('SELECT set_config($1,$2,true)', ['app.ip', row.source_ip ?? '']);
  await client.query('SELECT set_config($1,$2,true)', ['app.user_agent', 'hikvision-worker']);
  await client.query('SELECT set_config($1,$2,true)', ['app.device', row.device_serial_number ?? '']);
}

async function findEmployee(
  client: pg.PoolClient,
  companyId: number,
  tenantId: number,
  deviceId: number | null,
  identifier: string
): Promise<EmployeeRow | null> {
  // 1) Explicit ERP <-> Hikvision link (device-specific wins over global).
  const linkRes = await client.query(
    `SELECT e.id, e.company_id, e.tenant_id, e.branch_id, e.department_id,
            e.employee_no, e.first_name, e.last_name, e.position, e.status
       FROM hikvision_employee_links l
       JOIN employees e ON e.id = l.employee_id
      WHERE l.company_id = $1
        AND l.employee_identifier = $2
        AND l.status = 'ACTIVE'
        AND e.status = 'ACTIVE'
        AND (l.device_id = $3 OR l.device_id IS NULL)
      ORDER BY (l.device_id = $3) DESC
      LIMIT 1`,
    [companyId, identifier, deviceId]
  );
  if (linkRes.rows.length > 0) return linkRes.rows[0] as unknown as EmployeeRow;

  // 2) ERP employee number fields (employee_no primary, then alternate numbers).
  const empRes = await client.query(
    `SELECT id, company_id, tenant_id, branch_id, department_id,
            employee_no, first_name, last_name, position, status
       FROM employees
      WHERE company_id = $1
        AND status = 'ACTIVE'
        AND (employee_no = $2 OR employee_number = $2 OR short_employee_number = $2)
      ORDER BY (employee_no = $2) DESC
      LIMIT 1`,
    [companyId, identifier]
  );
  if (empRes.rows.length > 0) return empRes.rows[0] as unknown as EmployeeRow;

  // 3) Issued identities (RFID card, biometric reference, short badge).
  const idRes = await client.query(
    `SELECT e.id, e.company_id, e.tenant_id, e.branch_id, e.department_id,
            e.employee_no, e.first_name, e.last_name, e.position, e.status
       FROM employee_identities i
       JOIN employees e ON e.id = i.employee_id
      WHERE i.tenant_id = $1
        AND e.company_id = $2
        AND e.status = 'ACTIVE'
        AND i.status = 'ACTIVE'
        AND i.identity_type IN ('RFID_IDENTITY','BIOMETRIC_REFERENCE','SHORT_BADGE_ID')
        AND i.identity_number = $3
      LIMIT 1`,
    [tenantId, companyId, identifier]
  );
  return idRes.rows.length > 0 ? (idRes.rows[0] as unknown as EmployeeRow) : null;
}

async function exceptionExists(
  client: pg.PoolClient,
  companyId: number,
  employeeId: number | null,
  exceptionType: string,
  tz: string,
  fromMs: number
): Promise<boolean> {
  const day = tzDateKey(fromMs, tz);
  const start = zonedDateTimeToUtc(day, '00:00', tz);
  const end = zonedDateTimeToUtc(day, '23:59:59', tz);
  const res = await client.query(
    `SELECT 1 FROM attendance_exceptions
      WHERE company_id = $1
        AND exception_type = $3
        AND status IN (${EXCEPTION_STATES_OPEN})
        AND (($2::bigint IS NULL AND employee_id IS NULL) OR employee_id = $2)
        AND event_time BETWEEN $4::timestamptz AND $5::timestamptz
      LIMIT 1`,
    [companyId, employeeId, exceptionType, start, end]
  );
  return res.rows.length > 0;
}

async function createException(
  client: pg.PoolClient,
  device: DeviceRow,
  input: {
    employeeId?: number | null;
    employeeIdentifier?: string | null;
    exceptionType: string;
    severity?: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
    summary: string;
    eventTimeIso?: string | null;
    rawEventId: number;
  }
): Promise<void> {
  const res = await client.query(
    `INSERT INTO attendance_exceptions
       (tenant_id, company_id, branch_id, employee_id, device_id, raw_event_id,
        exception_type, severity, status, employee_identifier, event_time, summary, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10,$11,$12)
     RETURNING id`,
    [
      device.tenant_id,
      device.company_id,
      device.branch_id ?? null,
      input.employeeId ?? null,
      device.id,
      input.rawEventId,
      input.exceptionType,
      input.severity ?? 'WARN',
      input.employeeIdentifier ?? null,
      input.eventTimeIso ?? null,
      input.summary,
      JSON.stringify({ deviceCode: device.code, devicePurpose: device.device_purpose }),
    ]
  );
  const exceptionId = Number(res.rows[0].id);
  await logAudit(client, { tenantId: device.tenant_id, companyId: device.company_id }, {
    action: 'hikvision.exception.created',
    resource: 'attendance_exceptions',
    recordId: exceptionId,
    recordCode: input.exceptionType,
    metadata: {
      deviceId: device.id,
      rawEventId: input.rawEventId,
      employeeId: input.employeeId ?? null,
      employeeIdentifier: input.employeeIdentifier ?? null,
      summary: input.summary,
    },
  });
}

async function resolveShift(
  client: pg.PoolClient,
  companyId: number,
  employeeId: number,
  workDate: string,
  defaultShiftCode: string | null
): Promise<{ shift: ShiftRow | null; source: 'assignment' | 'default' | 'none' }> {
  const assignRes = await client.query(
    `SELECT s.id, s.code, s.name, TO_CHAR(s.start_time,'HH24:MI') AS start_time,
            TO_CHAR(s.end_time,'HH24:MI') AS end_time, s.grace_minutes,
            s.break_minutes, s.work_hours, s.status
       FROM shift_assignments sa
       JOIN shifts s ON s.id = sa.shift_id
      WHERE sa.company_id = $1
        AND sa.employee_id = $2
        AND sa.status = 'ACTIVE'
        AND s.status = 'ACTIVE'
        AND sa.effective_from <= $3::date
        AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
      ORDER BY sa.effective_from DESC
      LIMIT 1`,
    [companyId, employeeId, workDate]
  );
  if (assignRes.rows.length > 0) return { shift: assignRes.rows[0] as unknown as ShiftRow, source: 'assignment' };
  if (defaultShiftCode) {
    const defRes = await client.query(
      `SELECT id, code, name, TO_CHAR(start_time,'HH24:MI') AS start_time,
              TO_CHAR(end_time,'HH24:MI') AS end_time, grace_minutes,
              break_minutes, work_hours, status
         FROM shifts
        WHERE company_id = $1 AND code = $2 AND status = 'ACTIVE'
        LIMIT 1`,
      [companyId, defaultShiftCode]
    );
    if (defRes.rows.length > 0) return { shift: defRes.rows[0] as unknown as ShiftRow, source: 'default' };
  }
  return { shift: null, source: 'none' };
}

/** Process one claimed raw event. Returns true when the row reached a terminal state. */
async function processRowInTx(
  client: pg.PoolClient,
  row: ClaimedRawEvent,
  device: DeviceRow,
  payload: StoredPayload
): Promise<boolean> {
  const eventTimeIso = toIso(row.device_event_time);
  const employeeIdentifier = payload.employee_identifier?.trim() || null;
  const verificationMethod = classifyVerification(payload.verification) as VerificationMethod;
  const ctx = { tenantId: device.tenant_id, companyId: device.company_id, ip: row.source_ip ?? null };

  // --- Missing / unparseable event time -------------------------------------
  if (!eventTimeIso) {
    await client.query(
      `UPDATE hikvision_raw_events
          SET processing_status = 'REJECTED', error_message = $2, updated_at = now()
        WHERE id = $1`,
      [row.raw_event_id, 'INVALID_TIMESTAMP_MISSING']
    );
    await createException(client, device, {
      exceptionType: 'INVALID_TIMESTAMP',
      severity: 'WARN',
      summary: 'Event arrived without a usable device timestamp and was preserved without processing.',
      rawEventId: row.raw_event_id,
      employeeIdentifier,
    });
    await logAudit(client, ctx, {
      action: 'hikvision.event.rejected',
      resource: 'hikvision_raw_events',
      recordId: row.raw_event_id,
      recordCode: device.serial_number,
      metadata: { reason: 'INVALID_TIMESTAMP_MISSING', deviceId: device.id },
    });
    return true;
  }

  const evMs = Date.parse(eventTimeIso);
  const workDate = tzDateKey(evMs, device.timezone);
  const eventTimeValue = eventTimeIso;
  const rawEventType = row.event_type ?? payload.event_type ?? null;
  const location = device.physical_location || device.facility || null;

  // --- Resolve employee ------------------------------------------------------
  let employee: EmployeeRow | null = null;
  if (employeeIdentifier) {
    employee = await findEmployee(client, device.company_id, device.tenant_id, device.id, employeeIdentifier);
  }

  const classify = (punchCountToday: number, hasCheckIn: boolean, hasCheckOut: boolean, lastPunchType: string | null) =>
    classifyPunch({
      devicePurpose: device.device_purpose,
      rawEventType,
      accessStatus: payload.access_status ?? null,
      attendanceStatus: payload.attendance_status ?? null,
      punchCountToday,
      hasCheckIn,
      hasCheckOut,
      lastPunchType,
    });

  // --- Unknown employee -------------------------------------------------------
  if (!employee) {
    const classification = classify(0, false, false, null);
    await insertNormalizedEvent(client, device, row, {
      employeeIdentifier,
      employeeId: null,
      eventTimeIso,
      verificationMethod,
      eventType: classification.eventType,
      classificationReason: `${classification.reason}; employee not mapped`,
      location,
      attendancePunchId: null,
      extraMetadata: { rawEventType, payloadFormat: payload.format ?? row.payload_format },
    });
    const summary = employeeIdentifier
      ? `Employee number ${employeeIdentifier} is not mapped to an ERP employee.`
      : 'Event carried no employee identifier and could not be mapped.';
    await createException(client, device, {
      exceptionType: 'UNKNOWN_EMPLOYEE',
      severity: 'WARN',
      summary,
      eventTimeIso,
      employeeIdentifier,
      rawEventId: row.raw_event_id,
    });
    if (device.notify_unknown_employee) {
      await notifyRole(client, ctx, ['time_attendance_officer', 'hr_officer', 'security_administrator'], {
        type: 'HIKVISION_UNKNOWN_EMPLOYEE',
        title: 'Unknown Hikvision employee number',
        body: `${summary} Device: ${device.name} (${device.code}).`,
        entityType: 'hikvision_raw_events',
        entityId: row.raw_event_id,
        severity: 'WARN',
        actionRequired: true,
        data: { employeeIdentifier, deviceId: device.id, rawEventId: row.raw_event_id },
      });
    }
    await markProcessed(client, row, device, ctx, {
      employeeIdentifier,
      exceptionType: 'UNKNOWN_EMPLOYEE',
      eventType: classification.eventType,
      verificationMethod,
    });
    return true;
  }

  const classification = classify(0, false, false, null);
  const isAttendance = isAttendancePunch(classification.eventType);

  if (!isAttendance) {
    // Access / informational events: canonical record only (no punch, no shift math).
    await insertNormalizedEvent(client, device, row, {
      employeeIdentifier,
      employeeId: employee.id,
      eventTimeIso,
      verificationMethod,
      eventType: classification.eventType,
      classificationReason: classification.reason,
      location,
      attendancePunchId: null,
      extraMetadata: { employeeNumber: employee.employee_no, rawEventType, payloadFormat: payload.format ?? row.payload_format },
    });
    await markProcessed(client, row, device, ctx, {
      employeeIdentifier,
      employeeId: employee.id,
      eventType: classification.eventType,
      verificationMethod,
    });
    return true;
  }

  // --- Attendance punches -----------------------------------------------------
  if (!device.attendance_enabled) {
    await insertNormalizedEvent(client, device, row, {
      employeeIdentifier,
      employeeId: employee.id,
      eventTimeIso,
      verificationMethod,
      eventType: classification.eventType,
      classificationReason: `${classification.reason}; attendance disabled for device`,
      location,
      attendancePunchId: null,
      extraMetadata: { employeeNumber: employee.employee_no, rawEventType },
    });
    await markProcessed(client, row, device, ctx, {
      employeeIdentifier,
      employeeId: employee.id,
      eventType: classification.eventType,
      verificationMethod,
    });
    return true;
  }

  const dayStart = zonedDateTimeToUtc(workDate, '00:00', device.timezone);
  const dayEnd = zonedDateTimeToUtc(workDate, '23:59:59', device.timezone);

  const existingPunches = await client.query(
    `SELECT punch_type FROM attendance_punch_events
      WHERE employee_id = $1
        AND punch_time BETWEEN $2::timestamptz AND $3::timestamptz
        AND punch_type IN ('CHECK_IN','CHECK_OUT','BREAK_START','BREAK_END')
      ORDER BY punch_time`,
    [employee.id, dayStart, dayEnd]
  );
  const types = existingPunches.rows.map((r) => String(r.punch_type));
  const punchCountToday = types.length;
  const hasCheckIn = types.includes('CHECK_IN');
  const hasCheckOut = types.includes('CHECK_OUT');
  const lastPunchType = types.length > 0 ? types[types.length - 1] : null;

  const punchClassification = classify(punchCountToday, hasCheckIn, hasCheckOut, lastPunchType);
  const punchType = punchClassification.eventType as PunchType;

  // Existing record for the work date (any shift) - reuse it so a multi-device
  // day stays one record.
  const recordRes = await client.query(
    `SELECT id, shift_id, shift_code, scheduled_start, scheduled_end,
            grace_minutes, break_minutes, check_in, check_out, break_start,
            break_end, attendance_status, approval_status, raw_punch_count
       FROM attendance_records
      WHERE company_id = $1 AND employee_id = $2 AND work_date = $3::date
      ORDER BY (shift_id IS NULL), id
      LIMIT 1`,
    [device.company_id, employee.id, workDate]
  );
  let record: RecordRow | null = recordRes.rows.length > 0 ? (recordRes.rows[0] as unknown as RecordRow) : null;

  // Payroll lock gate: never touch records inside a LOCKED period.
  const periodRes = await client.query(
    `SELECT id, status FROM attendance_periods
      WHERE company_id = $1
        AND start_date <= $2::date AND end_date >= $2::date
        AND (branch_id IS NULL OR branch_id = $3)
      ORDER BY (branch_id IS NULL)
      LIMIT 1`,
    [device.company_id, workDate, device.branch_id ?? null]
  );
  const period: PeriodRow | null = periodRes.rows.length > 0 ? (periodRes.rows[0] as unknown as PeriodRow) : null;

  if (period?.status === 'LOCKED') {
    await insertNormalizedEvent(client, device, row, {
      employeeIdentifier,
      employeeId: employee.id,
      eventTimeIso,
      verificationMethod,
      eventType: punchType,
      classificationReason: `${punchClassification.reason}; period ${period.id} is LOCKED`,
      location,
      attendancePunchId: null,
      extraMetadata: { employeeNumber: employee.employee_no, periodId: period.id },
    });
    await createException(client, device, {
      employeeId: employee.id,
      employeeIdentifier,
      exceptionType: 'PERIOD_LOCKED',
      severity: 'WARN',
      summary: `Punch received for ${workDate} but the attendance period is LOCKED for payroll. No attendance record was modified.`,
      eventTimeIso,
      rawEventId: row.raw_event_id,
    });
    await markProcessed(client, row, device, ctx, {
      employeeIdentifier,
      employeeId: employee.id,
      eventType: punchType,
      verificationMethod,
      metadata: { periodLocked: true },
    });
    return true;
  }

  // Approved / adjusted records are immutable outside the adjustment workflow.
  if (record && (record.approval_status === 'APPROVED' || record.approval_status === 'ADJUSTED')) {
    await insertNormalizedEvent(client, device, row, {
      employeeIdentifier,
      employeeId: employee.id,
      eventTimeIso,
      verificationMethod,
      eventType: punchType,
      classificationReason: `${punchClassification.reason}; record ${record.id} is ${record.approval_status}`,
      location,
      attendancePunchId: null,
      extraMetadata: { employeeNumber: employee.employee_no, attendanceRecordId: record.id },
    });
    await createException(client, device, {
      employeeId: employee.id,
      employeeIdentifier,
      exceptionType: 'OTHER',
      severity: 'WARN',
      summary: `New punch for ${workDate} ignored: attendance record ${record.id} is ${record.approval_status}. Use an adjustment.`,
      eventTimeIso,
      rawEventId: row.raw_event_id,
    });
    await markProcessed(client, row, device, ctx, {
      employeeIdentifier,
      employeeId: employee.id,
      eventType: punchType,
      verificationMethod,
    });
    return true;
  }

  // Shift resolution: existing record shift > assignment > device default > none.
  let shift: ShiftRow | null = null;
  let shiftSource = 'none';
  if (record?.shift_id) {
    const sRes = await client.query(
      `SELECT id, code, name, TO_CHAR(start_time,'HH24:MI') AS start_time,
              TO_CHAR(end_time,'HH24:MI') AS end_time, grace_minutes,
              break_minutes, work_hours, status
         FROM shifts WHERE id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [record.shift_id]
    );
    if (sRes.rows.length > 0) {
      shift = sRes.rows[0] as unknown as ShiftRow;
      shiftSource = 'existing';
    }
  }
  if (!shift) {
    const resolved = await resolveShift(client, device.company_id, employee.id, workDate, device.default_shift_code);
    shift = resolved.shift;
    shiftSource = resolved.source;
  }

  const win = shift
    ? shiftWindow(workDate, shift.start_time, shift.end_time, device.timezone)
    : { startIso: null as string | null, endIso: null as string | null, overnight: false };

  if (!shift) {
    // No schedule to evaluate against: keep the punch, flag for the reviewer.
    if (!(await exceptionExists(client, device.company_id, employee.id, 'SHIFT_CONFLICT', device.timezone, evMs))) {
      await createException(client, device, {
        employeeId: employee.id,
        employeeIdentifier,
        exceptionType: 'SHIFT_CONFLICT',
        severity: 'WARN',
        summary: `Employee ${employee.employee_no} has no active shift assignment or default shift for ${workDate}.`,
        eventTimeIso,
        rawEventId: row.raw_event_id,
      });
    }
  }

  // Upsert attendance record (one per employee/work date/effective shift).
  const branchId = employee.branch_id ?? device.branch_id ?? null;
  const departmentId = employee.department_id ?? device.department_id ?? null;
  const graceMinutes = shift ? shift.grace_minutes : 0;
  const breakMinutes = shift ? shift.break_minutes : 0;

  const baseColumns = `
    tenant_id, company_id, branch_id, department_id, employee_id, work_date, period_id,
    shift_id, shift_code, scheduled_start, scheduled_end, grace_minutes, break_minutes,
    approval_status, source, segment_snapshot`;
  const baseValues = [
    device.tenant_id,
    device.company_id,
    branchId,
    departmentId,
    employee.id,
    workDate,
    period?.id ?? null,
    shift?.id ?? null,
    shift?.code ?? null,
    win.startIso,
    win.endIso,
    graceMinutes,
    breakMinutes,
    'DRAFT',
    'HIKVISION',
    JSON.stringify({
      deviceId: device.id,
      deviceCode: device.code,
      devicePurpose: device.device_purpose,
      shiftSource,
      timezone: device.timezone,
    }),
  ];

  // Build the typed INSERT..SELECT from the column list so parameter order can
  // never drift from baseColumns/baseValues again (candidate guard is $1..$4).
  const baseColumnList = baseColumns.replace(/\s+/g, ' ').split(',').map((s) => s.trim());
  const baseColumnTypes: Record<string, string> = {
    tenant_id: 'bigint', company_id: 'bigint', branch_id: 'bigint', department_id: 'bigint',
    employee_id: 'bigint', work_date: 'date', period_id: 'bigint', shift_id: 'bigint',
    shift_code: 'text', scheduled_start: 'timestamptz', scheduled_end: 'timestamptz',
    grace_minutes: 'int', break_minutes: 'int', approval_status: 'text', source: 'text',
    segment_snapshot: 'jsonb',
  };
  const typedRecordSelect = baseColumnList
    .map((col, i) => `$${i + 5}::${baseColumnTypes[col] ?? 'text'} AS ${col}`)
    .join(', ');

  const upserted = await client.query<RecordRow>(
    `WITH candidate AS (
       SELECT id FROM attendance_records
        WHERE company_id = $1 AND employee_id = $2 AND work_date = $3::date
          AND COALESCE(shift_id, 0) = $4
        FOR UPDATE
     )
     INSERT INTO attendance_records (${baseColumns})
     SELECT ${baseColumnList.map((col) => 'x.' + col).join(', ')}
       FROM (SELECT ${typedRecordSelect}) x
       WHERE NOT EXISTS (SELECT 1 FROM candidate)
     RETURNING id, shift_id, shift_code, scheduled_start, scheduled_end, grace_minutes,
               break_minutes, check_in, check_out, break_start, break_end,
               attendance_status, approval_status, raw_punch_count`,
    [
      device.company_id,
      employee.id,
      workDate,
      shift?.id ?? 0,
      ...baseValues,
    ]
  );

  let recordId = upserted.rows[0]?.id ?? null;
  if (!recordId) {
    const sel = await client.query<RecordRow>(
      `SELECT id, shift_id, shift_code, scheduled_start, scheduled_end, grace_minutes,
              break_minutes, check_in, check_out, break_start, break_end,
              attendance_status, approval_status, raw_punch_count
         FROM attendance_records
        WHERE company_id = $1 AND employee_id = $2 AND work_date = $3::date
          AND COALESCE(shift_id, 0) = $4
        LIMIT 1`,
      [device.company_id, employee.id, workDate, shift?.id ?? 0]
    );
    recordId = sel.rows[0]?.id ?? null;
  }
  if (!recordId) throw new Error('attendance record upsert failed');

  // Persist the punch (unique raw_event_id makes reprocessing idempotent).
  const punchRes = await client.query(
    `INSERT INTO attendance_punch_events
       (tenant_id, company_id, employee_id, attendance_record_id, device_id, raw_event_id,
        punch_time, punch_type, verification_method, device_purpose, location, segment, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (raw_event_id) DO NOTHING
     RETURNING id`,
    [
      device.tenant_id,
      device.company_id,
      employee.id,
      recordId,
      device.id,
      row.raw_event_id,
      eventTimeIso,
      punchType,
      verificationMethod,
      device.device_purpose,
      location,
      punchType === 'BREAK_START' || punchType === 'BREAK_END' ? 'BREAK' : punchType === 'CHECK_IN' ? 'IN' : punchType === 'CHECK_OUT' ? 'OUT' : null,
      JSON.stringify({
        deviceCode: device.code,
        rawEventId: row.raw_event_id,
        classificationReason: punchClassification.reason,
        employeeIdentifier,
      }),
    ]
  );
  const punchId = Number(punchRes.rows[0]?.id ?? 0);

  // Reload the merged record and recompute metrics.
  const finalRes = await client.query<RecordRow>(
    `SELECT id, shift_id, shift_code, scheduled_start, scheduled_end, grace_minutes,
            break_minutes, check_in, check_out, break_start, break_end,
            attendance_status, approval_status, raw_punch_count
       FROM attendance_records WHERE id = $1 FOR UPDATE`,
    [recordId]
  );
  const fresh = finalRes.rows[0] as RecordRow;

  // Apply the punch to the record fields (a punch always wins for its slot).
  const patch: Record<string, unknown> = {};
  if (punchType === 'CHECK_IN' && !fresh.check_in) patch.check_in = eventTimeIso;
  if (punchType === 'CHECK_OUT' && !fresh.check_out) patch.check_out = eventTimeIso;
  if (punchType === 'BREAK_START' && !fresh.break_start) patch.break_start = eventTimeIso;
  if (punchType === 'BREAK_END' && !fresh.break_end) patch.break_end = eventTimeIso;

  if (punchType === 'CHECK_IN' && fresh.check_in && fresh.check_in !== eventTimeIso) {
    patch.check_in = fresh.check_in < eventTimeIso ? fresh.check_in : eventTimeIso;
  }
  if (punchType === 'CHECK_OUT' && fresh.check_out && fresh.check_out !== eventTimeIso) {
    patch.check_out = fresh.check_out > eventTimeIso ? fresh.check_out : eventTimeIso;
  }
  if (punchType === 'BREAK_START' && fresh.break_start && fresh.break_start !== eventTimeIso) {
    patch.break_start = fresh.break_start < eventTimeIso ? fresh.break_start : eventTimeIso;
  }
  if (punchType === 'BREAK_END' && fresh.break_end && fresh.break_end !== eventTimeIso) {
    patch.break_end = fresh.break_end > eventTimeIso ? fresh.break_end : eventTimeIso;
  }

  const mergedCheckIn = (patch.check_in as string | undefined) ?? toIso(fresh.check_in);
  const mergedCheckOut = (patch.check_out as string | undefined) ?? toIso(fresh.check_out);
  const mergedBreakStart = (patch.break_start as string | undefined) ?? toIso(fresh.break_start);
  const mergedBreakEnd = (patch.break_end as string | undefined) ?? toIso(fresh.break_end);

  const metrics = computeMetrics({
    scheduledStartIso: win.startIso,
    scheduledEndIso: win.endIso,
    checkInIso: mergedCheckIn,
    checkOutIso: mergedCheckOut,
    breakStartIso: mergedBreakStart,
    breakEndIso: mergedBreakEnd,
    startTime: shift?.start_time ?? null,
    endTime: shift?.end_time ?? null,
    graceMinutes,
    breakMinutes,
  });

  const rawPunchCount = (fresh.raw_punch_count ?? 0) + (punchId > 0 ? 1 : 0);
  await client.query(
    `UPDATE attendance_records
        SET check_in = COALESCE($2, check_in),
            check_out = COALESCE($3, check_out),
            break_start = COALESCE($4, break_start),
            break_end = COALESCE($5, break_end),
            scheduled_start = COALESCE($6, scheduled_start),
            scheduled_end = COALESCE($7, scheduled_end),
            scheduled_minutes = $8,
            worked_minutes = $9,
            actual_minutes = $10,
            late_minutes = $11,
            early_departure_minutes = $12,
            overtime_minutes = $13,
            undertime_minutes = $14,
            attendance_status = $15,
            raw_punch_count = $16,
            updated_at = now()
      WHERE id = $1`,
    [
      recordId,
      mergedCheckIn,
      mergedCheckOut,
      mergedBreakStart,
      mergedBreakEnd,
      win.startIso,
      win.endIso,
      metrics.scheduledMinutes,
      metrics.workedMinutes,
      metrics.actualMinutes,
      metrics.lateMinutes,
      metrics.earlyDepartureMinutes,
      metrics.overtimeMinutes,
      metrics.undertimeMinutes,
      metrics.attendanceStatus,
      rawPunchCount,
    ]
  );

  // Exceptions derived from this punch (once per employee/day/type).
  if (punchType === 'CHECK_OUT' && !hasCheckIn &&
      !(await exceptionExists(client, device.company_id, employee.id, 'MISSING_CHECK_IN', device.timezone, evMs))) {
    await createException(client, device, {
      employeeId: employee.id,
      employeeIdentifier,
      exceptionType: 'MISSING_CHECK_IN',
      severity: 'WARN',
      summary: `Check-out received without a check-in for ${workDate}.`,
      eventTimeIso,
      rawEventId: row.raw_event_id,
    });
  } else if (punchType === 'CHECK_IN' && !hasCheckIn && metrics.lateMinutes > 0 &&
             !(await exceptionExists(client, device.company_id, employee.id, 'LATE_ARRIVAL', device.timezone, evMs))) {
    await createException(client, device, {
      employeeId: employee.id,
      employeeIdentifier,
      exceptionType: 'LATE_ARRIVAL',
      severity: 'INFO',
      summary: `Late arrival of ${metrics.lateMinutes} minute(s) on ${workDate}.`,
      eventTimeIso,
      rawEventId: row.raw_event_id,
    });
  } else if (punchType === 'CHECK_OUT' && !hasCheckOut && metrics.earlyDepartureMinutes > 0 &&
             !(await exceptionExists(client, device.company_id, employee.id, 'EARLY_DEPARTURE', device.timezone, evMs))) {
    await createException(client, device, {
      employeeId: employee.id,
      employeeIdentifier,
      exceptionType: 'EARLY_DEPARTURE',
      severity: 'INFO',
      summary: `Early departure of ${metrics.earlyDepartureMinutes} minute(s) on ${workDate}.`,
      eventTimeIso,
      rawEventId: row.raw_event_id,
    });
  }

  await insertNormalizedEvent(client, device, row, {
    employeeIdentifier,
    employeeId: employee.id,
    eventTimeIso,
    verificationMethod,
    eventType: punchType,
    classificationReason: punchClassification.reason,
    location,
    attendancePunchId: punchId > 0 ? punchId : null,
    extraMetadata: {
      employeeNumber: employee.employee_no,
      attendanceRecordId: recordId,
      shiftCode: shift?.code ?? null,
      shiftSource,
      periodId: period?.id ?? null,
      metrics,
      rawEventType,
    },
  });

  await markProcessed(client, row, device, ctx, {
    employeeIdentifier,
    employeeId: employee.id,
    eventType: punchType,
    verificationMethod,
    metadata: {
      attendanceRecordId: recordId,
      attendancePunchId: punchId > 0 ? punchId : null,
      shiftSource,
      lateMinutes: metrics.lateMinutes,
      overtimeMinutes: metrics.overtimeMinutes,
      workedMinutes: metrics.workedMinutes,
    },
  });
  return true;
}

async function insertNormalizedEvent(
  client: pg.PoolClient,
  device: DeviceRow,
  row: ClaimedRawEvent,
  input: {
    employeeIdentifier: string | null;
    employeeId: number | null;
    eventTimeIso: string;
    verificationMethod: VerificationMethod;
    eventType: string;
    classificationReason: string;
    location: string | null;
    attendancePunchId: number | null;
    extraMetadata?: Record<string, unknown>;
  }
): Promise<void> {
  const received = await client.query('SELECT received_at FROM hikvision_raw_events WHERE id = $1', [row.raw_event_id]);
  const receivedIso = received.rows.length > 0 ? toIso(received.rows[0].received_at) : new Date().toISOString();
  const payload = (row.payload ?? {}) as StoredPayload;
  const fields = (payload.fields ?? {}) as Record<string, unknown>;
  const eventId = fields.eventId != null ? String(fields.eventId) : fields.event_id != null ? String(fields.event_id) : null;
  await client.query(
    `INSERT INTO hikvision_normalized_events
       (tenant_id, company_id, raw_event_id, device_id, event_id, employee_identifier,
        employee_id, event_time, received_time, verification_method, event_type, location,
        classification_reason, attendance_punch_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (raw_event_id) DO NOTHING`,
    [
      device.tenant_id,
      device.company_id,
      row.raw_event_id,
      device.id,
      eventId,
      input.employeeIdentifier,
      input.employeeId,
      input.eventTimeIso,
      receivedIso,
      input.verificationMethod,
      input.eventType,
      input.location,
      input.classificationReason,
      input.attendancePunchId,
      JSON.stringify({ ...(input.extraMetadata ?? {}), payloadFormat: payload.format ?? row.payload_format }),
    ]
  );
}

async function markProcessed(
  client: pg.PoolClient,
  row: ClaimedRawEvent,
  device: DeviceRow,
  ctx: { tenantId: number; companyId: number },
  meta: {
    employeeIdentifier: string | null;
    employeeId?: number | null;
    eventType: string;
    verificationMethod: string;
    exceptionType?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `UPDATE hikvision_raw_events
        SET processing_status = 'PROCESSED', error_message = NULL, updated_at = now()
      WHERE id = $1`,
    [row.raw_event_id]
  );
  await logAudit(client, ctx, {
    action: 'hikvision.event.processed',
    resource: 'hikvision_raw_events',
    recordId: row.raw_event_id,
    recordCode: device.serial_number,
    metadata: {
      deviceId: device.id,
      employeeIdentifier: meta.employeeIdentifier,
      employeeId: meta.employeeId ?? null,
      eventType: meta.eventType,
      verificationMethod: meta.verificationMethod,
      exceptionType: meta.exceptionType ?? null,
      ...(meta.metadata ?? {}),
    },
  });
}

/** Run inside the per-row transaction. Returns true on a terminal state. */
async function processClaimedRow(row: ClaimedRawEvent): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);
    const deviceRes = await client.query(DEVICE_SQL, [row.device_id]);
    if (deviceRes.rows.length === 0) {
      // Device deleted or unreadable: terminal reject, keep audit trail.
      await client.query(
        `UPDATE hikvision_raw_events
            SET processing_status = 'REJECTED', error_message = $2, updated_at = now()
          WHERE id = $1`,
        [row.raw_event_id, 'UNMAPPED_DEVICE']
      );
      await client.query('COMMIT');
      return true;
    }
    const device = deviceRes.rows[0] as unknown as DeviceRow;
    const payload = (row.payload ?? {}) as StoredPayload;
    const ok = await processRowInTx(client, row, device, payload);
    await client.query('COMMIT');
    return ok;
  } catch (err) {
    await client.query('ROLLBACK');
    await recordFailure(row, err);
    return false;
  } finally {
    client.release();
  }
}

/** Persist a processing failure and flip the raw event to FAILED (retryable). */
async function recordFailure(row: ClaimedRawEvent, err: unknown): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);
    const message = errMsg(err);
    await client.query(
      `INSERT INTO hikvision_integration_errors
         (tenant_id, company_id, device_id, raw_event_id, stage, error_code,
          error_message, payload, stack)
       VALUES ($1,$2,$3,$4,'PROCESSING','PROCESSING_FAILED',$5,$6,$7)`,
      [
        row.tenant_id,
        row.company_id,
        row.device_id,
        row.raw_event_id,
        message.slice(0, 2000),
        JSON.stringify(row.payload ?? {}),
        (err instanceof Error && err.stack ? err.stack : message).slice(0, 4000),
      ]
    );
    await client.query(
      `UPDATE hikvision_raw_events
          SET processing_status = 'FAILED', retry_count = retry_count + 1,
              last_error = $2, error_message = $2, updated_at = now()
        WHERE id = $1`,
      [row.raw_event_id, message.slice(0, 2000)]
    );
    await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id }, {
      action: 'hikvision.event.failed',
      resource: 'hikvision_raw_events',
      recordId: row.raw_event_id,
      recordCode: row.device_serial_number,
      metadata: { deviceId: row.device_id, error: message.slice(0, 500), stage: 'PROCESSING' },
    });
    await client.query('COMMIT');
  } catch (inner) {
    await client.query('ROLLBACK');
    console.error('[hikvision][processor] failure-logging error', errMsg(inner));
  } finally {
    client.release();
  }
}

let draining = false;

/** Claim and process a batch of queued raw events. Single-flight safe. */
export async function drainHikvisionQueue(batch = 25): Promise<{ claimed: number; processed: number; failed: number }> {
  if (draining) return { claimed: 0, processed: 0, failed: 0 };
  draining = true;
  try {
    const res = await pool.query('SELECT * FROM hikvision_claim_raw_events($1, 300)', [batch]);
    const rows = res.rows as unknown as ClaimedRawEvent[];
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const ok = await processClaimedRow(row);
      if (ok) processed += 1;
      else failed += 1;
    }
    return { claimed: rows.length, processed, failed };
  } finally {
    draining = false;
  }
}

let healthSweeping = false;

/** Flip stale ONLINE/WARNING terminals to OFFLINE via the SECURITY DEFINER sweep. */
export async function runHikvisionHealthSweep(): Promise<number> {
  if (healthSweeping) return 0;
  healthSweeping = true;
  try {
    const res = await pool.query('SELECT * FROM hikvision_device_health_sweep(NULL)');
    return res.rows.length;
  } finally {
    healthSweeping = false;
  }
}

/** Single tick used by the API scheduler (idempotent, never throws). */
export async function runHikvisionWorkerTick(): Promise<void> {
  try {
    await drainHikvisionQueue(25);
    await runHikvisionHealthSweep();
  } catch (err) {
    console.error('[hikvision][worker]', err instanceof Error ? err.message : err);
  }
}
