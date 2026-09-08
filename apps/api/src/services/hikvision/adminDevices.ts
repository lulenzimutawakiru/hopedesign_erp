/**
 * Hikvision device administration service (Administration > Integrations >
 * Hikvision > Devices). All functions run inside the caller's transaction and
 * enforce organizational scope (tenant + company + branch) on every query.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound, conflict } from '../../utils.js';
import { logAudit } from '../audit.js';
import { sha256Hex, generateDeviceKey } from './security.js';
import { cleanBool, cleanInt, cleanStr, cleanStrArray, cleanIso, resolveOrg, scopeWhere, OrgScope } from './adminCommon.js';
import { encryptDeviceSecret, decryptDeviceSecret, probeDevice, syncDeviceClockRemote } from './remote.js';

export const HIK_DEVICE_PURPOSES = [
  'ENTRY', 'EXIT', 'ATTENDANCE', 'BREAK_ENTRY', 'BREAK_EXIT',
  'PRODUCTION', 'WAREHOUSE', 'SECURE_AREA',
] as const;

export const HIK_DEVICE_STATUSES = [
  'ONLINE', 'OFFLINE', 'WARNING', 'MAINTENANCE', 'DISABLED',
] as const;

interface DeviceJoinRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  department_id: number | null;
  code: string;
  name: string;
  model: string | null;
  serial_number: string;
  ip_address: string | null;
  mac_address: string | null;
  facility: string | null;
  physical_location: string | null;
  device_purpose: string;
  timezone: string;
  firmware_version: string | null;
  isapi_enabled: boolean;
  isapi_username: string | null;
  enabled: boolean;
  connection_status: string;
  status_reason: string | null;
  auth_key_prefix: string | null;
  ip_allowlist: string[] | null;
  allow_query_key: boolean;
  timestamp_skew_seconds: number | null;
  last_heartbeat_at: Date | string | null;
  last_event_at: Date | string | null;
  last_clock_drift_seconds: number | null;
  company_name: string | null;
  branch_name: string | null;
  department_name: string | null;
}

const DEVICE_JOIN_SQL = `
  SELECT d.*,
         c.name AS company_name,
         b.name AS branch_name,
         dp.name AS department_name
    FROM hikvision_devices d
    LEFT JOIN companies c   ON c.id = d.company_id
    LEFT JOIN branches b    ON b.id = d.branch_id
    LEFT JOIN departments dp ON dp.id = d.department_id`;

const pick = <T extends Record<string, unknown>>(row: T): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...row };
  delete out.isapi_encrypted_password;
  delete out.isapi_username;
  return out;
};

async function fetchScopedDevice(c: pg.PoolClient, scope: OrgScope, deviceId: number): Promise<DeviceJoinRow> {
  const res = await c.query(`${DEVICE_JOIN_SQL} WHERE d.id = $1 AND d.tenant_id = $2`, [deviceId, scope.tenantId]);
  if (res.rows.length === 0) throw notFound('Device not found');
  const row = res.rows[0] as unknown as DeviceJoinRow;
  if (scope.companyId !== null && Number(row.company_id) !== scope.companyId) throw forbidden('Cross-company access denied');
  if (scope.branchId !== null && row.branch_id !== null && Number(row.branch_id) !== scope.branchId) {
    throw forbidden('Cross-branch access denied');
  }
  return row;
}

async function getConfig(c: pg.PoolClient, deviceId: number): Promise<Record<string, unknown> | null> {
  const res = await c.query('SELECT * FROM hikvision_device_configurations WHERE device_id = $1', [deviceId]);
  return res.rows.length > 0 ? (res.rows[0] as Record<string, unknown>) : null;
}

async function ensureConfig(
  c: pg.PoolClient,
  scope: OrgScope,
  deviceId: number,
  createdBy: number | null
): Promise<Record<string, unknown>> {
  const existing = await getConfig(c, deviceId);
  if (existing) return existing;
  const ins = await c.query(
    `INSERT INTO hikvision_device_configurations
       (tenant_id, company_id, device_id, created_by)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [scope.tenantId, scope.companyId, deviceId, createdBy]
  );
  return ins.rows[0] as Record<string, unknown>;
}

function deviceAuditPick(scope: OrgScope, prefix: string): Record<string, unknown> {
  return { tenantId: scope.tenantId, companyId: scope.companyId, branchId: scope.branchId };
}

const validIpv4 = (s: string): boolean => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s);
const validMac = (s: string): boolean => /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(s);
/** List devices within the caller's scope with optional filters/pagination. */
export async function listDevices(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const scoped = scopeWhere(scope, 'd');
  const conds = [scoped.clause];
  const params: unknown[] = [...scoped.params];
  const status = cleanStr(q.status, 24);
  if (status) {
    if (!(HIK_DEVICE_STATUSES as readonly string[]).includes(status)) throw badRequest('Invalid device status filter');
    params.push(status);
    conds.push(`d.connection_status = $${params.length}`);
  }
  const purpose = cleanStr(q.purpose, 24);
  if (purpose) {
    if (!(HIK_DEVICE_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Invalid device purpose filter');
    params.push(purpose);
    conds.push(`d.device_purpose = $${params.length}`);
  }
  const text = cleanStr(q.q, 120);
  if (text) {
    params.push(`%${text}%`);
    conds.push(`(d.name ILIKE $${params.length} OR d.code ILIKE $${params.length} OR d.model ILIKE $${params.length} OR d.serial_number ILIKE $${params.length} OR d.ip_address ILIKE $${params.length})`);
  }
  const deviceId = q.deviceId !== undefined ? cleanInt(q.deviceId) : null;
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push(`d.id = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const page = Math.max(1, cleanInt(q.page, 1_000_000, 1) ?? 1);
  const pageSize = Math.min(500, cleanInt(q.pageSize, 500, 1) ?? 50);
  const offset = (page - 1) * pageSize;
  const countRes = await c.query(`SELECT count(*)::int AS total FROM hikvision_devices d WHERE ${where}`, params);
  const total = Number(countRes.rows[0]?.total ?? 0);
  const listRes = await c.query(
    `${DEVICE_JOIN_SQL} WHERE ${where} ORDER BY d.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const items = listRes.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return pick(row);
  });
  return { items, total, page, pageSize };
}

/** Full device detail: configuration, locations, telemetry and recent activity. */
export async function getDeviceDetail(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const device = await fetchScopedDevice(c, scope, deviceId);
  const [config, locations, heartbeats, healthLogs, recentEvents, recentExceptions, stats] = await Promise.all([
    ensureConfig(c, scope, deviceId, ctx.userId ?? null),
    c.query(
      `SELECT id, facility, physical_location, zone, is_active, effective_from, effective_to, metadata
         FROM hikvision_device_locations WHERE device_id = $1 ORDER BY effective_from DESC NULLS LAST, id DESC`,
      [deviceId]
    ),
    c.query(
      `SELECT id, heartbeat_at, device_time, clock_drift_seconds, ip_address, firmware_version, metadata
         FROM hikvision_device_heartbeats WHERE device_id = $1 ORDER BY heartbeat_at DESC LIMIT 20`,
      [deviceId]
    ),
    c.query(
      `SELECT id, health_type, previous_status, new_status, message, severity, created_at
         FROM hikvision_device_health_logs WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [deviceId]
    ),
    c.query(
      `SELECT id, device_serial_number, payload_format, device_event_time, event_type, processing_status,
              retry_count, duplicate_of_raw_event_id, created_at
         FROM hikvision_raw_events WHERE device_id = $1 ORDER BY id DESC LIMIT 20`,
      [deviceId]
    ),
    c.query(
      `SELECT id, exception_type, severity, status, employee_identifier, event_time, summary, created_at
         FROM attendance_exceptions WHERE device_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [deviceId]
    ),
    c.query(
      `SELECT
         count(*) FILTER (WHERE processing_status = 'PROCESSED')::int  AS processed_24h,
         count(*) FILTER (WHERE processing_status = 'DUPLICATE')::int  AS duplicates_24h,
         count(*) FILTER (WHERE processing_status = 'FAILED')::int     AS failed_24h,
         count(*) FILTER (WHERE processing_status = 'REJECTED')::int   AS rejected_24h,
         count(*)::int                                                 AS events_24h
       FROM hikvision_raw_events
       WHERE device_id = $1 AND created_at >= now() - interval '24 hours'`,
      [deviceId]
    ),
  ]);
  return {
    device: pick(device as unknown as Record<string, unknown>),
    configuration: config,
    locations: locations.rows,
    heartbeats: heartbeats.rows.slice(0, 20),
    healthLogs: healthLogs.rows.slice(0, 20),
    recentEvents: recentEvents.rows.slice(0, 20),
    recentExceptions: recentExceptions.rows.slice(0, 10),
    stats: stats.rows[0] ?? {},
  };
}

/** Register a new terminal. Returns the one-time webhook device key. */
export async function createDevice(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, {
    companyId: body.companyId,
    branchId: body.branchId,
    departmentId: body.departmentId,
  });
  if (scope.companyId === null) throw badRequest('companyId is required to register a device');
  const name = cleanStr(body.name, 160);
  if (!name) throw badRequest('Device name is required');
  const serialNumber = cleanStr(body.serialNumber, 64);
  if (!serialNumber) throw badRequest('Serial number is required');
  const ipAddress = cleanStr(body.ipAddress, 64);
  if (ipAddress && !validIpv4(ipAddress)) throw badRequest('Invalid IPv4 address');
  const macAddress = cleanStr(body.macAddress, 32);
  if (macAddress && !validMac(macAddress)) throw badRequest('Invalid MAC address');
  const purpose = cleanStr(body.devicePurpose, 24) ?? 'ATTENDANCE';
  if (!(HIK_DEVICE_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Invalid device purpose');
  const code = cleanStr(body.code, 40);
  const timezone = cleanStr(body.timezone, 64) ?? 'UTC';
  const dup = await c.query(
    'SELECT 1 FROM hikvision_devices WHERE tenant_id = $1 AND serial_number = $2',
    [scope.tenantId, serialNumber]
  );
  if (dup.rows.length > 0) throw conflict('A device with this serial number is already registered');

  const deviceKey = generateDeviceKey();
  const username = cleanStr(body.isapiUsername, 64);
  const isapiEnabled = cleanBool(body.isapiEnabled) ?? (username !== null);
  const encPassword = isapiEnabled ? encryptDeviceSecret(cleanStr(body.isapiPassword, 128)) : null;
  const allowQueryKey = cleanBool(body.allowQueryKey) ?? false;
  const enabled = cleanBool(body.enabled) ?? true;
  const ipAllowlist = cleanStrArray(body.ipAllowlist);
  let finalCode = code;
  if (!finalCode) {
    finalCode = `HIK-${Buffer.from(Math.random().toString()).toString('hex').slice(2, 6).toUpperCase()}`;
  }
  const inserted = await c.query(
    `INSERT INTO hikvision_devices
       (tenant_id, company_id, branch_id, department_id, code, name, model, serial_number,
        ip_address, mac_address, facility, physical_location, device_purpose, timezone,
        firmware_version, isapi_enabled, isapi_username, isapi_encrypted_password,
        enabled, connection_status, auth_key_hash, auth_key_prefix, ip_allowlist,
        allow_query_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING *`,
    [
      scope.tenantId, scope.companyId, scope.branchId, scope.departmentId, finalCode, name,
      cleanStr(body.model, 80), serialNumber, ipAddress, macAddress,
      cleanStr(body.facility, 160), cleanStr(body.physicalLocation, 160), purpose, timezone,
      cleanStr(body.firmwareVersion, 60), isapiEnabled, username, encPassword,
      enabled, 'OFFLINE', sha256Hex(deviceKey), deviceKey.slice(0, 8).toUpperCase(),
      ipAllowlist, allowQueryKey, ctx.userId ?? null,
    ]
  );
  const row = inserted.rows[0] as unknown as DeviceJoinRow;
  const deviceId = Number(row.id);
  await persistConfig(c, scope, deviceId, body, ctx.userId ?? null);
  if (cleanStr(body.facility, 160) || cleanStr(body.physicalLocation, 160)) {
    await insertLocation(c, scope, deviceId, body, ctx.userId ?? null);
  }
  await logAudit(c, ctx, {
    action: 'hikvision.device.created',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: serialNumber,
    newValues: { code: finalCode, name, model: row.model, serialNumber, ipAddress, devicePurpose: purpose, timezone },
    metadata: deviceAuditPick(scope, 'created'),
  });
  return {
    device: pick(row as unknown as Record<string, unknown>),
    deviceKey,
    message: 'Device registered. Store the device key securely - it is shown only once.',
  };
}

// ---- Device configuration ---------------------------------------------------

interface ConfigMeta {
  bodyKey: string;
  col: string;
  kind: 'bool' | 'int' | 'str';
  def: boolean | number | string | null;
  max: number;
  min: number;
}

const CONFIG_META: ConfigMeta[] = [
  { bodyKey: 'attendanceEnabled', col: 'attendance_enabled', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'accessEventsEnabled', col: 'access_events_enabled', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'duplicateWindowSeconds', col: 'duplicate_window_seconds', kind: 'int', def: 30, max: 3600, min: 0 },
  { bodyKey: 'replayWindowSeconds', col: 'replay_window_seconds', kind: 'int', def: 60, max: 86400, min: 0 },
  { bodyKey: 'allowFutureMinutes', col: 'allow_future_minutes', kind: 'int', def: 5, max: 1440, min: 0 },
  { bodyKey: 'allowPastMinutes', col: 'allow_past_minutes', kind: 'int', def: 1440, max: 525600, min: 0 },
  { bodyKey: 'breakStart', col: 'break_start', kind: 'str', def: null, max: 8, min: 0 },
  { bodyKey: 'breakEnd', col: 'break_end', kind: 'str', def: null, max: 8, min: 0 },
  { bodyKey: 'defaultShiftCode', col: 'default_shift_code', kind: 'str', def: null, max: 40, min: 0 },
  { bodyKey: 'notifyDeviceOffline', col: 'notify_device_offline', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'notifyDeviceOnline', col: 'notify_device_online', kind: 'bool', def: false, max: 0, min: 0 },
  { bodyKey: 'notifyClockDrift', col: 'notify_clock_drift', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'notifyUnknownEmployee', col: 'notify_unknown_employee', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'notifyIntegrationFailure', col: 'notify_integration_failure', kind: 'bool', def: true, max: 0, min: 0 },
  { bodyKey: 'clockDriftWarningSeconds', col: 'clock_drift_warning_seconds', kind: 'int', def: 120, max: 86400, min: 0 },
  { bodyKey: 'heartbeatStaleSeconds', col: 'heartbeat_stale_seconds', kind: 'int', def: 300, max: 86400, min: 0 },
  { bodyKey: 'heartbeatIntervalSeconds', col: 'heartbeat_interval_seconds', kind: 'int', def: 60, max: 86400, min: 0 },
];

/**
 * Merge caller-supplied configuration values over the current row (or schema
 * defaults when no row exists) and write the full configuration row back.
 * Unknown keys are ignored; omitted keys keep their existing value, which
 * gives PATCH semantics without fragile dynamic SQL.
 */
async function persistConfig(
  c: pg.PoolClient,
  scope: OrgScope,
  deviceId: number,
  body: Record<string, unknown>,
  userId: number | null
): Promise<Record<string, unknown>> {
  const existing = await getConfig(c, deviceId);
  const values: Record<string, unknown> = {};
  for (const meta of CONFIG_META) {
    let current: unknown = meta.def;
    if (existing && existing[meta.col] !== null && existing[meta.col] !== undefined) current = existing[meta.col];
    const raw = body[meta.bodyKey];
    if (raw !== undefined) {
      if (meta.kind === 'bool') {
        const b = cleanBool(raw);
        if (b !== null) current = b;
      } else if (meta.kind === 'int') {
        const n = cleanInt(raw, meta.max, meta.min);
        if (n !== null) current = n;
      } else {
        const s = cleanStr(raw, meta.max);
        if (s !== null || raw === null) current = s;
      }
    }
    values[meta.col] = current;
  }
  const cols = CONFIG_META.map((m) => m.col);
  if (!existing) {
    const placeholders = [...cols.map((_col, i) => `$${i + 4}`), `$${cols.length + 4}`].join(', ');
    const columnList = [...cols, 'created_by'].join(', ');
    const ins = await c.query(
      `INSERT INTO hikvision_device_configurations (tenant_id, company_id, device_id, ${columnList})
       VALUES ($1,$2,$3,${placeholders}) RETURNING *`,
      [scope.tenantId, scope.companyId, deviceId, ...cols.map((col) => values[col]), userId]
    );
    return ins.rows[0] as Record<string, unknown>;
  }
  const assignments = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
  await c.query(
    `UPDATE hikvision_device_configurations
        SET ${assignments}, updated_by = $${cols.length + 2}, updated_at = now()
      WHERE device_id = $1`,
    [deviceId, ...cols.map((col) => values[col]), userId]
  );
  return { ...(existing as Record<string, unknown>), ...values };
}

/** Insert a new active location placement and retire any previous active one. */
async function insertLocation(
  c: pg.PoolClient,
  scope: OrgScope,
  deviceId: number,
  body: Record<string, unknown>,
  userId: number | null
): Promise<Record<string, unknown> | null> {
  const facility = cleanStr(body.facility, 160);
  const physicalLocation = cleanStr(body.physicalLocation, 160);
  if (!facility || !physicalLocation) return null;
  await c.query(
    `UPDATE hikvision_device_locations
        SET is_active = false, updated_by = $2, updated_at = now()
      WHERE device_id = $1 AND is_active = true`,
    [deviceId, userId]
  );
  const ins = await c.query(
    `INSERT INTO hikvision_device_locations
       (tenant_id, company_id, branch_id, device_id, facility, physical_location, zone, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [scope.tenantId, scope.companyId, scope.branchId, deviceId, facility, physicalLocation, cleanStr(body.zone, 80), userId]
  );
  return { id: Number(ins.rows[0].id) };
}

// ---- Mutations --------------------------------------------------------------

const DEVICE_EDIT_COLS: Record<string, string> = {
  name: 'name',
  model: 'model',
  code: 'code',
  ipAddress: 'ip_address',
  macAddress: 'mac_address',
  facility: 'facility',
  physicalLocation: 'physical_location',
  devicePurpose: 'device_purpose',
  timezone: 'timezone',
  firmwareVersion: 'firmware_version',
  isapiUsername: 'isapi_username',
  isapiEnabled: 'isapi_enabled',
  allowQueryKey: 'allow_query_key',
};

/** Update device master data + operational configuration (PATCH semantics). */
export async function updateDevice(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId, departmentId: body.departmentId });
  const device = await fetchScopedDevice(c, scope, deviceId);
  const serialNumber = String(device.serial_number);

  const requestedSerial = cleanStr(body.serialNumber, 64);
  if (requestedSerial && requestedSerial !== serialNumber) {
    throw badRequest('Serial number cannot be changed after registration');
  }
  const ipAddress = cleanStr(body.ipAddress, 64);
  if (ipAddress && !validIpv4(ipAddress)) throw badRequest('Invalid IPv4 address');
  const macAddress = cleanStr(body.macAddress, 32);
  if (macAddress && !validMac(macAddress)) throw badRequest('Invalid MAC address');
  const purpose = cleanStr(body.devicePurpose, 24);
  if (purpose && !(HIK_DEVICE_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Invalid device purpose');
  const timezone = cleanStr(body.timezone, 64);

  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [deviceId];
  for (const [bodyKey, col] of Object.entries(DEVICE_EDIT_COLS)) {
    const raw = body[bodyKey];
    if (raw === undefined) continue;
    let next: unknown = null;
    if (col === 'ip_address') next = ipAddress;
    else if (col === 'mac_address') next = macAddress;
    else if (col === 'device_purpose') next = purpose;
    else if (col === 'timezone') next = timezone;
    else if (col === 'code' || col === 'name' || col === 'model' || col === 'facility' ||
             col === 'physical_location' || col === 'firmware_version' || col === 'isapi_username') {
      next = cleanStr(raw, col === 'code' ? 40 : col === 'name' ? 160 : col === 'isapi_username' ? 64 : 80);
    } else if (col === 'isapi_enabled' || col === 'allow_query_key') {
      const b = cleanBool(raw);
      if (b !== null) next = b;
      else continue;
    }
    const prev = (device as unknown as Record<string, unknown>)[col];
    if (String(prev ?? '') === String(next ?? '')) continue;
    params.push(next);
    sets.push(`${col} = $${params.length}`);
    oldValues[bodyKey] = prev;
    newValues[bodyKey] = next;
  }

  const password = cleanStr(body.isapiPassword, 128);
  if (password) {
    params.push(encryptDeviceSecret(password));
    sets.push('isapi_encrypted_password = $' + params.length);
    oldValues.isapiPassword = '(redacted)';
    newValues.isapiPassword = '(updated)';
  }
  const ipAllowlist = body.ipAllowlist !== undefined ? cleanStrArray(body.ipAllowlist) : null;
  if (ipAllowlist !== null) {
    params.push(ipAllowlist);
    sets.push('ip_allowlist = $' + params.length);
    oldValues.ipAllowlist = device.ip_allowlist ?? [];
    newValues.ipAllowlist = ipAllowlist;
  }

  if (body.isapiEnabled === false) {
    params.push(null);
    sets.push('isapi_encrypted_password = $' + params.length);
    newValues.isapiPassword = '(cleared)';
  }

  // Organizational references may only stay within the same company.
  const branchId = body.branchId !== undefined ? cleanInt(body.branchId) : null;
  const departmentId = body.departmentId !== undefined ? cleanInt(body.departmentId) : null;
  if (branchId !== null) {
    const b = await c.query('SELECT company_id FROM branches WHERE id = $1 AND tenant_id = $2', [branchId, scope.tenantId]);
    if (b.rows.length === 0) throw forbidden('Branch is outside your scope');
    if (Number(b.rows[0].company_id) !== Number(device.company_id)) throw forbidden('Branch does not belong to the device company');
    params.push(branchId);
    sets.push('branch_id = $' + params.length);
    oldValues.branchId = device.branch_id ?? null;
    newValues.branchId = branchId;
  }
  if (departmentId !== null) {
    const d = await c.query(
      'SELECT company_id, branch_id FROM departments WHERE id = $1 AND tenant_id = $2',
      [departmentId, scope.tenantId]
    );
    if (d.rows.length === 0) throw forbidden('Department is outside your scope');
    if (Number(d.rows[0].company_id) !== Number(device.company_id)) throw forbidden('Department does not belong to the device company');
    params.push(departmentId);
    sets.push('department_id = $' + params.length);
    oldValues.departmentId = device.department_id ?? null;
    newValues.departmentId = departmentId;
  }
  if (body.companyId !== undefined) {
    const requestedCompany = cleanInt(body.companyId);
    if (requestedCompany !== null && requestedCompany !== Number(device.company_id)) {
      throw badRequest('A device cannot be moved to another company after registration');
    }
  }

  if (sets.length > 0) {
    await c.query(
      `UPDATE hikvision_devices SET ${sets.join(', ')}, updated_by = $${params.length + 1}, updated_at = now() WHERE id = $1`,
      [...params, ctx.userId ?? null]
    );
  }
  await persistConfig(c, scope, deviceId, body, ctx.userId ?? null);

  await logAudit(c, ctx, {
    action: 'hikvision.device.updated',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: serialNumber,
    oldValues: Object.keys(oldValues).length > 0 ? oldValues : null,
    newValues: Object.keys(newValues).length > 0 ? newValues : null,
    metadata: deviceAuditPick(scope, 'updated'),
  });
  const fresh = await fetchScopedDevice(c, scope, deviceId);
  return pick(fresh as unknown as Record<string, unknown>);
}

const STATUS_VALUES = ['ONLINE', 'OFFLINE', 'WARNING', 'MAINTENANCE', 'DISABLED'];

/** Administratively set a device connection/operational status. */
export async function setDeviceStatus(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const device = await fetchScopedDevice(c, scope, deviceId);
  const status = cleanStr(body.status, 24);
  if (!status || !STATUS_VALUES.includes(status)) throw badRequest('Invalid device status');
  const reason = cleanStr(body.reason, 300);
  const previous = String(device.connection_status);
  if (previous === status) {
    return { device: pick(device as unknown as Record<string, unknown>), changed: false, previous, status };
  }
  const nextEnabled = status !== 'DISABLED';
  await c.query(
    `UPDATE hikvision_devices
        SET connection_status = $2, enabled = $3, status_reason = $4,
            updated_by = $5, updated_at = now()
      WHERE id = $1`,
    [deviceId, status, nextEnabled, reason ?? `Status set to ${status}`, ctx.userId ?? null]
  );
  await c.query(
    `INSERT INTO hikvision_device_health_logs
       (tenant_id, company_id, device_id, health_type, previous_status, new_status, message, severity, metadata)
     VALUES ($1,$2,$3,'STATUS_CHANGE',$4,$5,$6,$7,$8)`,
    [
      scope.tenantId, Number(device.company_id), deviceId, previous, status,
      reason ?? `Status changed from ${previous} to ${status}`,
      status === 'OFFLINE' || status === 'DISABLED' ? 'WARN' : 'INFO',
      JSON.stringify({ actor: 'admin', userId: ctx.userId ?? null }),
    ]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.device.status_changed',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: String(device.serial_number),
    oldValues: { connectionStatus: previous, enabled: device.enabled },
    newValues: { connectionStatus: status, enabled: nextEnabled, reason: reason ?? null },
    metadata: deviceAuditPick(scope, 'status'),
  });
  const fresh = await fetchScopedDevice(c, scope, deviceId);
  return { device: pick(fresh as unknown as Record<string, unknown>), changed: true, previous, status };
}

/** Rotate the shared webhook key. The new key is returned exactly once. */
export async function rotateDeviceKey(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const device = await fetchScopedDevice(c, scope, deviceId);
  const deviceKey = generateDeviceKey();
  await c.query(
    `UPDATE hikvision_devices
        SET auth_key_hash = $2, auth_key_prefix = $3, updated_by = $4, updated_at = now()
      WHERE id = $1`,
    [deviceId, sha256Hex(deviceKey), deviceKey.slice(0, 8).toUpperCase(), ctx.userId ?? null]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.device.key_rotated',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: String(device.serial_number),
    oldValues: { authKeyPrefix: device.auth_key_prefix },
    newValues: { authKeyPrefix: deviceKey.slice(0, 8).toUpperCase() },
    metadata: deviceAuditPick(scope, 'rotate_key'),
  });
  return { deviceId, deviceKey, message: 'Device key rotated. Store the new key securely - it is shown only once.' };
}

/**
 * Delete a device. When raw events exist the device is soft-disabled so the
 * audit trail and event history are never orphaned; otherwise the registration
 * is removed permanently.
 */
export async function deleteDevice(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const device = await fetchScopedDevice(c, scope, deviceId);
  const serialNumber = String(device.serial_number);
  const reason = cleanStr(body.reason, 300) ?? 'Deleted by administrator';
  const eventCount = await c.query('SELECT count(*)::int AS n FROM hikvision_raw_events WHERE device_id = $1', [deviceId]);
  const hasEvents = Number(eventCount.rows[0]?.n ?? 0) > 0;
  if (hasEvents) {
    await c.query(
      `UPDATE hikvision_devices
          SET enabled = false, connection_status = 'DISABLED', status_reason = $2,
              updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [deviceId, reason, ctx.userId ?? null]
    );
    await c.query(
      `INSERT INTO hikvision_device_health_logs
         (tenant_id, company_id, device_id, health_type, previous_status, new_status, message, severity, metadata)
       VALUES ($1,$2,$3,'STATUS_CHANGE',$4,'DISABLED',$5,'WARN',$6)`,
      [
        scope.tenantId, Number(device.company_id), deviceId, String(device.connection_status), reason,
        JSON.stringify({ actor: 'admin', softDelete: true, userId: ctx.userId ?? null }),
      ]
    );
    await logAudit(c, ctx, {
      action: 'hikvision.device.disabled',
      resource: 'hikvision_devices',
      recordId: deviceId,
      recordCode: serialNumber,
      oldValues: { enabled: device.enabled, connectionStatus: device.connection_status },
      newValues: { enabled: false, connectionStatus: 'DISABLED', reason },
      metadata: deviceAuditPick(scope, 'delete'),
    });
    return { deviceId, deleted: false, softDisabled: true, reason };
  }
  await c.query('DELETE FROM hikvision_devices WHERE id = $1 AND tenant_id = $2', [deviceId, scope.tenantId]);
  await logAudit(c, ctx, {
    action: 'hikvision.device.deleted',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: serialNumber,
    oldValues: { name: device.name, serialNumber },
    metadata: deviceAuditPick(scope, 'delete'),
  });
  return { deviceId, deleted: true, softDisabled: false, reason };
}

interface RemoteResultLike {
  ok: boolean;
  status: number;
  message: string;
}

/** Record clock drift and optionally push server time to the terminal (ISAPI). */
export async function recordDeviceTimeSync(
  c: pg.PoolClient,
  ctx: Ctx,
  deviceId: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const device = await fetchScopedDevice(c, scope, deviceId);
  const config = await ensureConfig(c, scope, deviceId, ctx.userId ?? null);
  const warningSeconds = Number(config.clock_drift_warning_seconds ?? 120) || 120;
  const hb = await c.query(
    `SELECT device_time FROM hikvision_device_heartbeats
      WHERE device_id = $1 AND device_time IS NOT NULL
      ORDER BY heartbeat_at DESC LIMIT 1`,
    [deviceId]
  );
  const serverIso = new Date().toISOString();
  const driftSeconds = hb.rows.length > 0 ? Math.round((Date.now() - new Date(String(hb.rows[0].device_time)).getTime()) / 1000) : null;
  const absDrift = driftSeconds === null ? null : Math.abs(driftSeconds);
  let driftStatus = 'OK';
  if (absDrift !== null) {
    driftStatus = absDrift >= warningSeconds * 2 ? 'CRITICAL' : absDrift >= warningSeconds ? 'WARNING' : 'OK';
  }
  const syncRemote = cleanBool(body.syncRemote) ?? false;
  let remote: RemoteResultLike | null = null;
  const serialNumber = String(device.serial_number);

  if (driftSeconds !== null) {
    await c.query(
      `INSERT INTO hikvision_clock_drift_logs
         (tenant_id, company_id, device_id, device_time, server_time, drift_seconds, drift_abs_seconds, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.tenantId, Number(device.company_id), deviceId, hb.rows[0].device_time, serverIso,
        driftSeconds, absDrift, driftStatus,
        JSON.stringify({ checkedBy: ctx.userId ?? null }),
      ]
    );
  }

  if (syncRemote && Number(device.isapi_enabled) === 1 && String(device.ip_address ?? '') !== '') {
    const password = decryptDeviceSecret((device as unknown as Record<string, unknown>).isapi_encrypted_password as string | null);
    remote = await syncDeviceClockRemote(String(device.ip_address), cleanStr(device.isapi_username, 64), password, String(device.timezone ?? 'UTC'));
    if (remote.ok) {
      await c.query(
        `UPDATE hikvision_clock_drift_logs
            SET synced = true, synced_by = $2
          WHERE id = (SELECT max(id) FROM hikvision_clock_drift_logs WHERE device_id = $1)`,
        [deviceId, ctx.userId ?? null]
      );
      await c.query(
        `UPDATE hikvision_devices
            SET last_clock_drift_seconds = 0, timestamp_skew_seconds = 0, updated_at = now()
          WHERE id = $1`,
        [deviceId]
      );
    }
  }

  if (driftStatus !== 'OK') {
    await c.query(
      `INSERT INTO hikvision_device_health_logs
         (tenant_id, company_id, device_id, health_type, message, severity, metadata)
       VALUES ($1,$2,$3,'CLOCK_DRIFT',$4,$5,$6)`,
      [
        scope.tenantId, Number(device.company_id), deviceId,
        `Clock drift of ${absDrift}s detected (warning threshold ${warningSeconds}s)`,
        driftStatus === 'CRITICAL' ? 'CRITICAL' : 'WARN',
        JSON.stringify({ driftSeconds, driftStatus, syncRemote, userId: ctx.userId ?? null }),
      ]
    );
  }
  if (remote) {
    await c.query(
      `INSERT INTO hikvision_sync_logs
         (tenant_id, company_id, device_id, action, status, request_payload, response_payload, error_message, performed_by)
       VALUES ($1,$2,$3,'TIME_SYNC',$4,$5,$6,$7,$8)`,
      [
        scope.tenantId, Number(device.company_id), deviceId,
        remote.ok ? 'SUCCESS' : 'FAILED',
        JSON.stringify({ syncRemote: true }),
        JSON.stringify(remote),
        remote.ok ? null : remote.message,
        ctx.userId ?? null,
      ]
    );
  }

  await logAudit(c, ctx, {
    action: remote?.ok === true ? 'hikvision.device.time_synced' : 'hikvision.device.time_drift_checked',
    resource: 'hikvision_devices',
    recordId: deviceId,
    recordCode: serialNumber,
    newValues: { driftSeconds, driftStatus, serverTime: serverIso, syncRemote: syncRemote && !!remote, remote },
    metadata: deviceAuditPick(scope, 'time_sync'),
  });
  return {
    deviceId,
    serverTime: serverIso,
    deviceTime: hb.rows.length > 0 ? hb.rows[0].device_time : null,
    driftSeconds,
    driftStatus,
    thresholdSeconds: warningSeconds,
    remote,
  };
}

// ---- Dashboards -------------------------------------------------------------

function groupCounts(rows: { status?: string; n?: unknown }[], _key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.status ?? 'UNKNOWN')] = Number(r.n ?? 0);
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

/** Live Hikvision attendance dashboard KPIs + activity feed. */
export async function dashboardSummary(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const dScope = scopeWhere(scope, 'd');
  const eScope = scopeWhere(scope, 'e');

  const [statusRes, eventsRes, attendanceRes, employeesRes, exceptionsRes] = await Promise.all([
    c.query(
      `SELECT d.connection_status AS status, count(*)::int AS n
         FROM hikvision_devices d WHERE ${dScope.clause} GROUP BY 1`,
      dScope.params
    ),
    c.query(
      `SELECT
         count(*)::int                                                         AS total,
         count(*) FILTER (WHERE r.processing_status = 'PROCESSED')::int        AS processed,
         count(*) FILTER (WHERE r.processing_status = 'DUPLICATE')::int        AS duplicates,
         count(*) FILTER (WHERE r.processing_status = 'FAILED')::int           AS failed,
         count(*) FILTER (WHERE r.processing_status = 'REJECTED')::int         AS rejected,
         count(*) FILTER (WHERE r.processing_status IN ('RECEIVED','QUEUED','PROCESSING'))::int AS pending
       FROM hikvision_raw_events r
       JOIN hikvision_devices d ON d.id = r.device_id
       WHERE ${dScope.clause} AND r.created_at >= now()::date`,
      dScope.params
    ),
    c.query(
      `SELECT r.attendance_status AS status, count(*)::int AS n
         FROM attendance_records r
         JOIN employees e ON e.id = r.employee_id
         WHERE ${eScope.clause} AND r.work_date = CURRENT_DATE
         GROUP BY 1`,
      eScope.params
    ),
    c.query(
      `SELECT count(*)::int AS n FROM employees e WHERE ${eScope.clause} AND e.status = 'ACTIVE'`,
      eScope.params
    ),
    c.query(
      `SELECT count(*)::int AS n
         FROM attendance_exceptions x
        WHERE x.tenant_id = $1
          AND x.status IN ('OPEN','ASSIGNED','REVIEWING')
          ${scope.companyId !== null ? 'AND x.company_id = $2' : ''}
          ${scope.branchId !== null ? `AND (x.branch_id = $${scope.companyId !== null ? 3 : 2} OR x.branch_id IS NULL)` : ''}`,
      [
        scope.tenantId,
        ...(scope.companyId !== null ? [scope.companyId] : []),
        ...(scope.branchId !== null ? [scope.branchId] : []),
      ]
    ),
  ]);

  const feed = await c.query(
    `SELECT r.id, r.device_event_time, r.event_type, r.processing_status,
            r.payload->>'employee_identifier' AS employee_identifier,
            d.id AS device_id, d.name AS device_name, d.physical_location AS location,
            d.device_purpose,
            n.verification_method, n.event_type AS normalized_type,
            e.id AS employee_id, e.first_name, e.last_name, e.employee_no
       FROM hikvision_raw_events r
       JOIN hikvision_devices d ON d.id = r.device_id
       LEFT JOIN hikvision_normalized_events n ON n.raw_event_id = r.id
       LEFT JOIN employees e ON e.id = n.employee_id
      WHERE ${dScope.clause} AND r.created_at >= now() - interval '24 hours'
      ORDER BY r.id DESC LIMIT 30`,
    dScope.params
  );

  const byStatus = groupCounts(statusRes.rows as { status?: string; n?: unknown }[], 'status');
  const recordCounts = groupCounts(attendanceRes.rows as { status?: string; n?: unknown }[], 'status');
  const eventCounts = eventsRes.rows[0] ?? {};
  const exceptionsRow = exceptionsRes.rows[0] ?? { n: 0 };
  const present = ['PRESENT', 'LATE', 'EARLY_DEPARTURE', 'HALF_DAY']
    .reduce((a, s) => a + (recordCounts[s] ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    deviceCounts: byStatus,
    devicesOnline: byStatus.ONLINE ?? 0,
    devicesOffline: byStatus.OFFLINE ?? 0,
    warnings: (byStatus.WARNING ?? 0) + (byStatus.MAINTENANCE ?? 0),
    eventsToday: eventCounts,
    attendanceToday: {
      presentToday: present,
      checkedIn: Number(eventCounts.processed ?? 0),
      late: recordCounts.LATE ?? 0,
      absent: recordCounts.ABSENT ?? 0,
      onLeave: recordCounts.ON_LEAVE ?? 0,
      byStatus: recordCounts,
    },
    exceptionsOpen: Number(exceptionsRow.n ?? 0),
    employeesActive: Number(employeesRes.rows[0]?.n ?? 0),
    feed: feed.rows.map((row) => {
      const r = row as unknown as Record<string, unknown>;
      return {
        rawEventId: Number(r.id),
        employeeIdentifier: r.employee_identifier,
        employee: r.employee_id
          ? { id: Number(r.employee_id), name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), employeeNo: r.employee_no }
          : null,
        device: { id: Number(r.device_id), name: r.device_name, location: r.location, purpose: r.device_purpose },
        eventTime: r.device_event_time,
        eventType: r.normalized_type ?? r.event_type,
        verificationMethod: r.verification_method,
        status: r.processing_status,
      };
    }),
  };
}

/** Device health board: per-device status, heartbeat, last event and counts. */
export async function deviceHealthBoard(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const dScope = scopeWhere(scope, 'd');
  const listRes = await c.query(
    `SELECT d.id, d.code, d.name, d.model, d.serial_number, d.ip_address, d.device_purpose,
            d.connection_status, d.status_reason, d.enabled, d.timezone, d.firmware_version,
            d.last_heartbeat_at, d.last_event_at, d.last_clock_drift_seconds,
            b.name AS branch_name, dp.name AS department_name
       FROM hikvision_devices d
       LEFT JOIN branches b ON b.id = d.branch_id
       LEFT JOIN departments dp ON dp.id = d.department_id
      WHERE ${dScope.clause}
      ORDER BY d.id DESC LIMIT 1000`,
    dScope.params
  );
  const ids = listRes.rows.map((r) => Number((r as unknown as Record<string, unknown>).id));
  const eventsToday: Record<string, number> = {};
  const exceptionsOpen: Record<string, number> = {};
  if (ids.length > 0) {
    const ev = await c.query(
      `SELECT device_id, count(*)::int AS n
         FROM hikvision_raw_events
        WHERE device_id = ANY($1) AND created_at >= now()::date
        GROUP BY device_id`,
      [ids]
    );
    for (const row of ev.rows) {
      const rec = row as unknown as Record<string, unknown>;
      eventsToday[Number(rec.device_id)] = Number(rec.n);
    }
    const ex = await c.query(
      `SELECT device_id, count(*)::int AS n
         FROM attendance_exceptions
        WHERE device_id = ANY($1) AND status IN ('OPEN','ASSIGNED','REVIEWING')
        GROUP BY device_id`,
      [ids]
    );
    for (const row of ex.rows) {
      const rec = row as unknown as Record<string, unknown>;
      exceptionsOpen[Number(rec.device_id)] = Number(rec.n);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    devices: listRes.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      const id = Number(row.id);
      return {
        id,
        code: row.code, name: row.name, model: row.model, serialNumber: row.serial_number,
        ipAddress: row.ip_address, devicePurpose: row.device_purpose,
        connectionStatus: row.connection_status, statusReason: row.status_reason, enabled: row.enabled,
        timezone: row.timezone, firmwareVersion: row.firmware_version,
        lastHeartbeatAt: row.last_heartbeat_at, lastEventAt: row.last_event_at,
        lastClockDriftSeconds: row.last_clock_drift_seconds,
        branchName: row.branch_name, departmentName: row.department_name,
        eventsToday: eventsToday[id] ?? 0,
        exceptionsOpen: exceptionsOpen[id] ?? 0,
      };
    }),
  };
}