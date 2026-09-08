/**
 * Hikvision employee synchronization: the ERP-side employee<->device mapping
 * (hikvision_employee_links) plus an audited intent/sync log
 * (hikvision_sync_logs) for every provisioning action.
 *
 * Design rules:
 *  - We never auto-create HR records; the mapping only ever points at an
 *    existing employee inside the caller's organizational scope (ABAC).
 *  - Every sync action writes a hikvision_sync_logs row (SUCCESS / PARTIAL /
 *    FAILED / SKIPPED) and an audit_logs entry. Raw device enrolment remains a
 *    controlled operation: remote ISAPI provisioning is only attempted when
 *    the device is flagged provisioning-ready in its configuration metadata,
 *    otherwise the row is SKIPPED with an explicit reason so operations knows
 *    the state of the terminal - never a silent success.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../utils.js';
import { logAudit } from '../audit.js';
import { cleanInt, cleanStr, cleanStrArray, resolveOrg, scopeWhere, OrgScope } from './adminCommon.js';
import { isapiRequest, decryptDeviceSecret } from './remote.js';

const LINK_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
const VERIFY_METHODS = ['FACE', 'CARD', 'FINGERPRINT', 'PASSWORD', 'QR', 'UNKNOWN'];
const SYNC_ACTIONS = ['SYNC_EMPLOYEE', 'SYNC_SELECTED', 'BULK_SYNC', 'DEACTIVATE_EMPLOYEE', 'DISABLE_ACCESS', 'REMOVE_DEVICE_ACCESS', 'TIME_SYNC'];

function pageOf(q: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, cleanInt(q.page, 1_000_000, 1) ?? 1);
  const pageSize = Math.min(200, cleanInt(q.pageSize, 200, 1) ?? 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function fetchDevice(c: pg.PoolClient, scope: OrgScope, deviceId: number): Promise<Record<string, unknown>> {
  const conds: string[] = ['d.tenant_id = $1', 'd.id = $2'];
  const params: unknown[] = [scope.tenantId, deviceId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`d.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`d.branch_id = $${params.length}`);
  }
  const res = await c.query(
    `SELECT d.*, cfg.metadata AS configuration_metadata, cfg.attendance_enabled,
            cfg.access_events_enabled, cfg.duplicate_window_seconds
       FROM hikvision_devices d
       LEFT JOIN hikvision_device_configurations cfg
         ON cfg.device_id = d.id AND cfg.company_id = d.company_id
      WHERE ${conds.join(' AND ')}`,
    params
  );
  if (res.rows.length === 0) throw notFound('Device not found in your scope');
  return res.rows[0] as unknown as Record<string, unknown>;
}

async function fetchEmployee(c: pg.PoolClient, scope: OrgScope, employeeId: number): Promise<Record<string, unknown>> {
  const conds: string[] = ['e.tenant_id = $1', 'e.id = $2'];
  const params: unknown[] = [scope.tenantId, employeeId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`e.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`COALESCE(e.branch_id, e.company_id) = $${params.length}`);
  }
  const res = await c.query(
    `SELECT e.id, e.tenant_id, e.company_id, e.branch_id, e.department_id, e.employee_no,
            e.first_name, e.last_name, e.position, e.status
       FROM employees e
      WHERE ${conds.join(' AND ')}`,
    params
  );
  if (res.rows.length === 0) throw notFound('Employee not found in your scope');
  return res.rows[0] as unknown as Record<string, unknown>;
}

async function fetchLink(c: pg.PoolClient, scope: OrgScope, id: number): Promise<Record<string, unknown>> {
  const conds: string[] = ['l.tenant_id = $1', 'l.id = $2'];
  const params: unknown[] = [scope.tenantId, id];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`l.company_id = $${params.length}`);
  }
  const res = await c.query(
    `SELECT l.*, e.employee_no, e.first_name, e.last_name,
            d.code AS device_code, d.name AS device_name, d.serial_number AS device_serial
       FROM hikvision_employee_links l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN hikvision_devices d ON d.id = l.device_id
      WHERE ${conds.join(' AND ')}`,
    params
  );
  if (res.rows.length === 0) throw notFound('Employee link not found in your scope');
  return res.rows[0] as unknown as Record<string, unknown>;
}

function mapLink(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    companyId: Number(row.company_id),
    employeeId: Number(row.employee_id),
    employee: {
      id: Number(row.employee_id),
      employeeNo: row.employee_no,
      name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    },
    deviceId: row.device_id != null ? Number(row.device_id) : null,
    device: row.device_id != null
      ? { id: Number(row.device_id), code: row.device_code, name: row.device_name, serialNumber: row.device_serial }
      : null,
    employeeIdentifier: row.employee_identifier,
    verificationMethod: row.verification_method,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    updatedBy: row.updated_by != null ? Number(row.updated_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Guard against two ERP employees sharing an identifier on the same device. */
async function assertIdentifierFree(
  c: pg.PoolClient,
  scope: OrgScope,
  deviceId: number | null,
  employeeId: number,
  identifier: string,
  excludeLinkId: number | null = null
): Promise<void> {
  const conds: string[] = ['tenant_id = $1', 'company_id = $2', 'employee_identifier = $3'];
  const params: unknown[] = [scope.tenantId, scope.companyId, identifier];
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push('(device_id = $4 OR device_id IS NULL)');
  } else {
    conds.push('device_id IS NULL');
  }
  if (excludeLinkId !== null) {
    params.push(excludeLinkId);
    conds.push(`id <> $${params.length}`);
  }
  const res = await c.query(`SELECT id, employee_id FROM hikvision_employee_links WHERE ${conds.join(' AND ')} LIMIT 1`, params);
  if (res.rows.length > 0 && Number(res.rows[0].employee_id) !== employeeId) {
    throw badRequest('This employee identifier is already mapped to another employee on that device');
  }
}

/** List employee<->device links (org scoped). */
export async function listEmployeeLinks(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const pg = pageOf(q);
  const conds: string[] = ['l.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`l.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`COALESCE(d.branch_id, e.branch_id) = $${params.length}`);
  }
  const status = cleanStr(q.status, 24);
  if (status) {
    if (!LINK_STATUSES.includes(status)) throw badRequest('Invalid link status');
    params.push(status);
    conds.push(`l.status = $${params.length}`);
  }
  const deviceId = cleanInt(q.deviceId);
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push(`l.device_id = $${params.length}`);
  }
  const employeeId = cleanInt(q.employeeId);
  if (employeeId !== null) {
    params.push(employeeId);
    conds.push(`l.employee_id = $${params.length}`);
  }
  const text = cleanStr(q.q, 120);
  if (text) {
    params.push(`%${text}%`);
    conds.push(`(l.employee_identifier ILIKE $${params.length} OR e.employee_no ILIKE $${params.length} OR COALESCE(d.name,'') ILIKE $${params.length} OR COALESCE(e.first_name || ' ' || e.last_name,'') ILIKE $${params.length})`);
  }
  const where = conds.join(' AND ');
  const totalRes = await c.query(`SELECT count(*)::int AS total FROM hikvision_employee_links l JOIN employees e ON e.id = l.employee_id LEFT JOIN hikvision_devices d ON d.id = l.device_id WHERE ${where}`, params);
  const rowsRes = await c.query(
    `SELECT l.*, e.employee_no, e.first_name, e.last_name,
            d.code AS device_code, d.name AS device_name, d.serial_number AS device_serial
       FROM hikvision_employee_links l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN hikvision_devices d ON d.id = l.device_id
      WHERE ${where}
      ORDER BY l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pg.pageSize, pg.offset]
  );
  return {
    items: rowsRes.rows.map((r) => mapLink(r as unknown as Record<string, unknown>)),
    total: Number(totalRes.rows[0]?.total ?? 0),
    page: pg.page,
    pageSize: pg.pageSize,
  };
}

/** Manually create an employee<->device mapping. */
export async function createEmployeeLink(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  if (scope.companyId === null) throw badRequest('companyId is required to map an employee');
  const employeeId = cleanInt(body.employeeId);
  if (employeeId === null) throw badRequest('employeeId is required');
  await fetchEmployee(c, scope, employeeId);

  const deviceId = cleanInt(body.deviceId);
  if (deviceId !== null) await fetchDevice(c, scope, deviceId);

  const identifier = cleanStr(body.employeeIdentifier, 128);
  if (!identifier) throw badRequest('employeeIdentifier is required');
  const method = cleanStr(body.verificationMethod, 24) ?? 'UNKNOWN';
  if (!VERIFY_METHODS.includes(method)) throw badRequest('Invalid verification method');
  const status = cleanStr(body.status, 24) ?? 'ACTIVE';
  if (!LINK_STATUSES.includes(status)) throw badRequest('Invalid link status');
  const notes = cleanStr(body.notes, 500);

  await assertIdentifierFree(c, scope, deviceId, employeeId, identifier);

  const ins = await c.query(
    `INSERT INTO hikvision_employee_links
       (tenant_id, company_id, employee_id, device_id, employee_identifier, verification_method, status, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     RETURNING id`,
    [scope.tenantId, scope.companyId, employeeId, deviceId, identifier, method, status, notes, ctx.userId ?? null]
  );
  const linkId = Number(ins.rows[0].id);
  await logAudit(c, ctx, {
    action: 'hikvision.employee_link.created',
    resource: 'hikvision_employee_links',
    recordId: linkId,
    recordCode: identifier,
    metadata: { employeeId, deviceId, verificationMethod: method, status },
  });
  return { link: await fetchLink(c, scope, linkId) };
}

/** Update mapping metadata (identifier / verification method / status). */
export async function updateEmployeeLink(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const link = await fetchLink(c, scope, id);
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [id];

  const identifier = body.employeeIdentifier !== undefined ? cleanStr(body.employeeIdentifier, 128) : undefined;
  if (identifier !== undefined && identifier !== null && identifier !== String(link.employee_identifier ?? '')) {
    if (!identifier) throw badRequest('employeeIdentifier cannot be empty');
    await assertIdentifierFree(c, scope, link.device_id != null ? Number(link.device_id) : null, Number(link.employee_id), identifier, id);
    oldValues.employeeIdentifier = link.employee_identifier;
    newValues.employeeIdentifier = identifier;
    params.push(identifier);
    sets.push(`employee_identifier = $${params.length}`);
  }
  if (body.verificationMethod !== undefined) {
    const method = cleanStr(body.verificationMethod, 24);
    if (!method || !VERIFY_METHODS.includes(method)) throw badRequest('Invalid verification method');
    if (method !== String(link.verification_method ?? '')) {
      oldValues.verificationMethod = link.verification_method;
      newValues.verificationMethod = method;
      params.push(method);
      sets.push(`verification_method = $${params.length}`);
    }
  }
  if (body.status !== undefined) {
    const status = cleanStr(body.status, 24);
    if (!status || !LINK_STATUSES.includes(status)) throw badRequest('Invalid link status');
    if (status !== String(link.status ?? '')) {
      oldValues.status = link.status;
      newValues.status = status;
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
  }
  if (body.notes !== undefined) {
    const notes = cleanStr(body.notes, 500);
    if ((notes ?? null) !== (link.notes ?? null)) {
      oldValues.notes = link.notes;
      newValues.notes = notes;
      params.push(notes);
      sets.push(`notes = $${params.length}`);
    }
  }
  if (sets.length === 0) return { link: await fetchLink(c, scope, id), changed: false };

  params.push(ctx.userId ?? null);
  params.push(scope.tenantId);
  await c.query(
    `UPDATE hikvision_employee_links SET ${sets.join(', ')}, updated_by = $${params.length - 1}, updated_at = now() WHERE id = $1 AND tenant_id = $${params.length}`,
    params
  );

  await logAudit(c, ctx, {
    action: 'hikvision.employee_link.updated',
    resource: 'hikvision_employee_links',
    recordId: id,
    recordCode: String(link.employee_identifier ?? ''),
    oldValues,
    newValues,
  });
  return { link: await fetchLink(c, scope, id), changed: true };
}
// ============================================================================
// Part B - provisioning actions (ERP -> Hikvision ISAPI)
// ----------------------------------------------------------------------------
// Every public action resolves the organizational scope (ABAC), maps the ERP
// employee to the device identity, executes a real authenticated ISAPI PUT
// against the terminal, records a hikvision_sync_logs row and an audit_logs
// entry, and NEVER auto-creates HR records. Remote failures are returned as
// FAILED outcomes (never silently swallowed); devices that cannot accept
// commands produce SKIPPED outcomes with the concrete reason.
// ============================================================================

interface SyncOutcomeRow {
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  deviceId: number;
  deviceName: string;
  deviceSerial: string;
  status: string;
  message: string;
}

type ProvisionKind =
  | 'SYNC_EMPLOYEE'
  | 'SYNC_SELECTED'
  | 'BULK_SYNC'
  | 'DEACTIVATE_EMPLOYEE'
  | 'DISABLE_ACCESS'
  | 'REMOVE_DEVICE_ACCESS';

function mapSyncLog(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    companyId: Number(row.company_id),
    deviceId: row.device_id != null ? Number(row.device_id) : null,
    device: row.device_id != null
      ? { id: Number(row.device_id), code: row.device_code, name: row.device_name, serialNumber: row.device_serial }
      : null,
    employeeId: row.employee_id != null ? Number(row.employee_id) : null,
    employee: row.employee_id != null
      ? {
          id: Number(row.employee_id),
          employeeNo: row.employee_no,
          name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        }
      : null,
    action: row.action,
    status: row.status,
    requestPayload: row.request_payload,
    responsePayload: row.response_payload,
    errorMessage: row.error_message,
    performedBy: row.performed_by != null ? Number(row.performed_by) : null,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  };
}

/** ERP employee number fields, in priority order (mirrors event resolution). */
function bestEmployeeNumber(employee: Record<string, unknown>): string | null {
  const raw =
    employee.employee_no ??
    employee.employee_number ??
    employee.short_employee_number ??
    null;
  if (raw === null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s.slice(0, 32);
}

/**
 * Pick the identifier that must exist on a device for this employee.
 * Explicit links win (device-specific first, then a company-global link),
 * otherwise the ERP employee number fields are used.
 */
async function resolveEmployeeIdentifier(
  c: pg.PoolClient,
  scope: OrgScope,
  employee: Record<string, unknown>,
  deviceId: number | null
): Promise<string | null> {
  const companyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
  const tenantId = Number(employee.tenant_id ?? scope.tenantId);
  if (deviceId !== null) {
    const res = await c.query(
      `SELECT employee_identifier FROM hikvision_employee_links
        WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3
          AND status <> 'INACTIVE'
          AND (device_id = $4 OR device_id IS NULL)
        ORDER BY (device_id IS NULL) ASC, id ASC
        LIMIT 1`,
      [tenantId, companyId, Number(employee.id), deviceId]
    );
    if (res.rows.length > 0) return String(res.rows[0].employee_identifier).slice(0, 32);
  } else {
    const res = await c.query(
      `SELECT employee_identifier FROM hikvision_employee_links
        WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3
          AND status <> 'INACTIVE'
        ORDER BY id ASC
        LIMIT 1`,
      [tenantId, companyId, Number(employee.id)]
    );
    if (res.rows.length > 0) return String(res.rows[0].employee_identifier).slice(0, 32);
  }
  return bestEmployeeNumber(employee);
}

/** Can this device accept authenticated remote commands right now? */
function deviceCommandReadiness(device: Record<string, unknown>): { ready: boolean; reason?: string } {
  if (Number(device.enabled) !== 1 || String(device.connection_status ?? '') === 'DISABLED') {
    return { ready: false, reason: 'Device is disabled in the ERP' };
  }
  const status = String(device.connection_status ?? '');
  if (status !== 'ONLINE' && status !== 'WARNING') {
    return { ready: false, reason: `Device is ${status || 'OFFLINE'}; remote commands require ONLINE or WARNING` };
  }
  if (Number(device.isapi_enabled) !== 1) {
    return { ready: false, reason: 'ISAPI remote commands are disabled for this device' };
  }
  const ip = cleanStr(device.ip_address, 64);
  if (!ip) return { ready: false, reason: 'Device has no IP address configured for remote commands' };
  const user = cleanStr(device.isapi_username, 64);
  if (!user) return { ready: false, reason: 'Device has no ISAPI username configured' };
  const pass = decryptDeviceSecret(device.isapi_encrypted_password as string | null);
  if (!pass) return { ready: false, reason: 'Device has no ISAPI password configured' };
  return { ready: true, reason: undefined };
}

/** Build the ISAPI UserInfo body for an ENABLE or DISABLE provisioning PUT. */
function buildUserInfoBody(
  employee: Record<string, unknown>,
  identifier: string,
  mode: 'ENABLE' | 'DISABLE',
  cardNo: string | null,
  doorNo: number,
  planTemplateNo: string
): string {
  const name = `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim().slice(0, 63) || identifier;
  const beginTime = new Date();
  const endTime = new Date(beginTime.getTime() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const userInfo: Record<string, unknown> = {
    employeeNo: identifier,
    name,
    userType: 'normal',
    Valid: {
      enable: mode === 'ENABLE',
      beginTime: beginTime.toISOString(),
      endTime,
    },
    doorRight: mode === 'ENABLE' ? String(doorNo) : '',
    localUIRight: true,
    maxOpenDoorTime: 5,
    RightPlan: mode === 'ENABLE' ? [{ doorNo, planTemplateNo }] : [],
  };
  if (mode === 'ENABLE' && cardNo && String(cardNo).trim().length > 0) {
    userInfo.cardNo = String(cardNo).trim().slice(0, 32);
  }
  return JSON.stringify({ UserInfo: userInfo });
}

/** Write one hikvision_sync_logs row for a device action. */
async function logSync(
  c: pg.PoolClient,
  scope: OrgScope,
  ctx: Ctx,
  entry: {
    deviceId: number;
    employeeId: number | null;
    companyId: number;
    action: ProvisionKind;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string | null;
  }
): Promise<number> {
  const ins = await c.query(
    `INSERT INTO hikvision_sync_logs
       (tenant_id, company_id, device_id, employee_id, action, status,
        request_payload, response_payload, error_message, performed_by, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      scope.tenantId,
      entry.companyId,
      entry.deviceId,
      entry.employeeId,
      entry.action,
      entry.status,
      JSON.stringify(entry.requestPayload ?? {}),
      JSON.stringify(entry.responsePayload ?? {}),
      entry.errorMessage ?? null,
      ctx.userId ?? null,
      ctx.ip ?? null,
    ]
  );
  return Number(ins.rows[0].id);
}

/** Latest active RFID identity issued to an employee (used as the card number). */
async function fetchActiveRfidCard(
  c: pg.PoolClient,
  tenantId: number,
  companyId: number,
  employeeId: number
): Promise<string | null> {
  const res = await c.query(
    `SELECT identity_number FROM employee_identities
      WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3
        AND identity_type = 'RFID_IDENTITY' AND status = 'ACTIVE'
      ORDER BY id DESC LIMIT 1`,
    [tenantId, companyId, employeeId]
  );
  return res.rows.length > 0 ? String(res.rows[0].identity_number) : null;
}

/** Move an employee's mapping state on a device (company-global links included). */
async function setLinkStatus(
  c: pg.PoolClient,
  ctx: Ctx,
  tenantId: number,
  companyId: number,
  employeeId: number,
  deviceId: number,
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
): Promise<{ matched: number }> {
  const res = await c.query(
    `UPDATE hikvision_employee_links
        SET status = $1, updated_by = $2, updated_at = now()
      WHERE tenant_id = $3 AND company_id = $4 AND employee_id = $5
        AND (device_id = $6 OR device_id IS NULL)
        AND status <> 'INACTIVE'`,
    [status, ctx.userId ?? null, tenantId, companyId, employeeId, deviceId]
  );
  return { matched: res.rowCount ?? 0 };
}

/**
 * Provision one employee to one terminal over ISAPI. Returns a per-row outcome
 * and writes the matching hikvision_sync_logs entry. Never throws for remote
 * failures - it converts them into FAILED rows so batch flows can continue.
 */
async function syncEmployeeToDeviceAction(
  c: pg.PoolClient,
  ctx: Ctx,
  scope: OrgScope,
  employee: Record<string, unknown>,
  device: Record<string, unknown>,
  kind: ProvisionKind,
  opts: { cardNo?: string | null; doorNo: number; planTemplateNo: string }
): Promise<SyncOutcomeRow> {
  const deviceId = Number(device.id);
  const deviceName = String(device.name ?? '');
  const deviceSerial = String(device.serial_number ?? '');
  const employeeId = Number(employee.id);
  const employeeCompanyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
  const deviceCompanyId = device.company_id != null ? Number(device.company_id) : null;
  const employeeNo = String(bestEmployeeNumber(employee) ?? '');
  const employeeName = `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim();

  const refuse = async (reason: string): Promise<SyncOutcomeRow> => {
    const syncId = await logSync(c, scope, ctx, {
      deviceId,
      employeeId,
      companyId: employeeCompanyId ?? deviceCompanyId ?? scope.companyId ?? 0,
      action: kind,
      status: 'SKIPPED',
      requestPayload: { reason },
      errorMessage: reason,
    });
    return { employeeId, employeeNo, employeeName, deviceId, deviceName, deviceSerial, status: 'SKIPPED', message: reason };
  };

  if (employeeCompanyId === null) return refuse('Employee is not attached to a company');
  if (deviceCompanyId !== null && deviceCompanyId !== employeeCompanyId) {
    return refuse('Employee and device belong to different companies; cross-company provisioning denied');
  }

  const identifier = await resolveEmployeeIdentifier(c, scope, employee, deviceId);
  if (!identifier) {
    return refuse('Employee has no employee number available to provision on the device');
  }

  const readiness = deviceCommandReadiness(device);
  if (!readiness.ready) {
    return refuse(readiness.reason ?? 'Device not ready for remote commands');
  }

  const ip = String(device.ip_address ?? '');
  const user = String(device.isapi_username ?? '');
  const pass = decryptDeviceSecret(device.isapi_encrypted_password as string | null) ?? '';
  if (!ip || !user || !pass) return refuse('Device ISAPI credentials are incomplete');

  const doorNo = Math.max(1, Math.min(99, opts.doorNo));
  const planTemplateNo = String(opts.planTemplateNo ?? '1').slice(0, 16) || '1';
  const cardNo =
    kind === 'DISABLE_ACCESS' || kind === 'DEACTIVATE_EMPLOYEE' || kind === 'REMOVE_DEVICE_ACCESS'
      ? null
      : opts.cardNo ?? null;

  let path: string;
  let bodyText: string;
  let mode: 'ENABLE' | 'DISABLE' | null = null;
  if (kind === 'REMOVE_DEVICE_ACCESS') {
    path = '/ISAPI/AccessControl/UserInfo/Record/Delete?format=json';
    bodyText = JSON.stringify({ UserInfo: { employeeNoList: identifier } });
  } else {
    mode = kind === 'DISABLE_ACCESS' || kind === 'DEACTIVATE_EMPLOYEE' ? 'DISABLE' : 'ENABLE';
    path = '/ISAPI/AccessControl/UserInfo/Record?format=json';
    bodyText = buildUserInfoBody(employee, identifier, mode, cardNo, doorNo, planTemplateNo);
  }

  let parsedBody: unknown = {};
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    parsedBody = bodyText;
  }
  const remote = await isapiRequest(ip, user, pass, 'PUT', path, bodyText);
  const syncId = await logSync(c, scope, ctx, {
    deviceId,
    employeeId,
    companyId: employeeCompanyId,
    action: kind,
    status: remote.ok ? 'SUCCESS' : 'FAILED',
    requestPayload: { method: 'PUT', path, body: parsedBody },
    responsePayload: { httpStatus: remote.status, message: remote.message },
    errorMessage: remote.ok ? null : remote.message,
  });

  if (remote.ok) {
    if (mode === 'ENABLE') {
      await setLinkStatus(c, ctx, scope.tenantId, employeeCompanyId, employeeId, deviceId, 'ACTIVE');
    } else if (kind === 'DISABLE_ACCESS') {
      await setLinkStatus(c, ctx, scope.tenantId, employeeCompanyId, employeeId, deviceId, 'SUSPENDED');
    } else {
      await setLinkStatus(c, ctx, scope.tenantId, employeeCompanyId, employeeId, deviceId, 'INACTIVE');
    }
  }

  return {
    employeeId,
    employeeNo,
    employeeName,
    deviceId,
    deviceName,
    deviceSerial,
    status: remote.ok ? 'SUCCESS' : 'FAILED',
    message: remote.ok
      ? `Provisioned on ${deviceName} (sync log ${syncId})`
      : `${remote.message} (sync log ${syncId})`,
  };
}

/** All devices inside the caller's organizational scope. */
async function listScopedDevices(c: pg.PoolClient, scope: OrgScope): Promise<Record<string, unknown>[]> {
  const conds: string[] = ['tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`branch_id = $${params.length}`);
  }
  const res = await c.query(
    `SELECT * FROM hikvision_devices WHERE ${conds.join(' AND ')} ORDER BY id ASC`,
    params
  );
  return res.rows as unknown as Record<string, unknown>[];
}

/** Resolve an explicit device target, or list the whole scoped fleet. */
async function collectTargetDevices(
  c: pg.PoolClient,
  scope: OrgScope,
  requestedDeviceId: number | null
): Promise<Record<string, unknown>[]> {
  if (requestedDeviceId !== null) return [await fetchDevice(c, scope, requestedDeviceId)];
  return listScopedDevices(c, scope);
}

function parseDeviceId(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = cleanInt(v);
  if (n === null) throw badRequest('Invalid deviceId');
  return n;
}

function summarize(rows: SyncOutcomeRow[]): { success: number; skipped: number; failed: number; total: number } {
  let success = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.status === 'SUCCESS') success += 1;
    else if (r.status === 'SKIPPED') skipped += 1;
  }
  return { success, skipped, failed: rows.length - success - skipped, total: rows.length };
}

function parseIntList(v: unknown, max: number, label: string): number[] {
  const parts: string[] = [];
  if (Array.isArray(v)) for (const x of v) parts.push(String(x));
  else if (typeof v === 'string' && v.trim() !== '') parts.push(...v.split(','));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of parts) {
    const n = cleanInt(p.trim());
    if (n !== null && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  if (out.length === 0) throw badRequest(`At least one ${label} is required`);
  if (out.length > max) throw badRequest(`At most ${max} ${label}s per request`);
  return out;
}

/** Run a provisioning kind for an employee across its target devices. */
async function provisionEmployee(
  c: pg.PoolClient,
  ctx: Ctx,
  scope: OrgScope,
  employee: Record<string, unknown>,
  kind: ProvisionKind,
  requestedDeviceId: number | null,
  opts: { cardNo?: string | null; doorNo: number; planTemplateNo: string }
): Promise<SyncOutcomeRow[]> {
  const targets = await collectTargetDevices(c, scope, requestedDeviceId);
  const rows: SyncOutcomeRow[] = [];
  for (const device of targets) {
    rows.push(await syncEmployeeToDeviceAction(c, ctx, scope, employee, device, kind, opts));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public provisioning actions
// ---------------------------------------------------------------------------

/** Sync one employee onto one device (or the whole fleet when deviceId is omitted). */
export async function syncEmployeeToDevice(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  const employeeId = cleanInt(body.employeeId);
  if (employeeId === null) throw badRequest('employeeId is required');
  const employee = await fetchEmployee(c, scope, employeeId);
  const deviceId = parseDeviceId(body.deviceId);
  const doorNo = cleanInt(body.doorNo, 99, 1) ?? 1;
  const planTemplateNo = cleanStr(body.planTemplateNo, 16) ?? '1';
  const employeeCompanyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
  let cardNo: string | null = null;
  if (body.cardNo !== undefined && body.cardNo !== null && body.cardNo !== '') {
    cardNo = String(body.cardNo).slice(0, 32);
  } else if (employeeCompanyId !== null) {
    cardNo = await fetchActiveRfidCard(c, scope.tenantId, employeeCompanyId, employeeId);
  }
  const items = await provisionEmployee(c, ctx, scope, employee, 'SYNC_EMPLOYEE', deviceId, {
    cardNo,
    doorNo,
    planTemplateNo,
  });
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.sync',
    resource: 'hikvision_employee_links',
    recordId: employeeId,
    recordCode: String(bestEmployeeNumber(employee) ?? ''),
    metadata: { employeeId, deviceId, summary },
  });
  return { items, summary };
}

/** Sync a specific list of employees onto one device or the whole fleet. */
export async function syncSelectedEmployees(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  const employeeIds = parseIntList(body.employeeIds, 200, 'employeeId');
  const deviceId = parseDeviceId(body.deviceId);
  const doorNo = cleanInt(body.doorNo, 99, 1) ?? 1;
  const planTemplateNo = cleanStr(body.planTemplateNo, 16) ?? '1';

  const items: SyncOutcomeRow[] = [];
  for (const employeeId of employeeIds) {
    const employee = await fetchEmployee(c, scope, employeeId);
    const employeeCompanyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
    const cardNo =
      employeeCompanyId !== null ? await fetchActiveRfidCard(c, scope.tenantId, employeeCompanyId, employeeId) : null;
    const rows = await provisionEmployee(c, ctx, scope, employee, 'SYNC_SELECTED', deviceId, {
      cardNo,
      doorNo,
      planTemplateNo,
    });
    items.push(...rows);
  }
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.bulk_sync',
    resource: 'hikvision_employee_links',
    metadata: { employeeIds, deviceId, summary },
  });
  return { items, summary, employeesRequested: employeeIds.length };
}

/** Bulk sync the active workforce (filtered by company/branch/department). */
export async function syncBulkEmployees(
  c: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, {
    companyId: body.companyId,
    branchId: body.branchId,
    departmentId: body.departmentId,
  });
  const conds: string[] = ['e.tenant_id = $1', "e.status = 'ACTIVE'"];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`e.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`COALESCE(e.branch_id, e.company_id) = $${params.length}`);
  }
  if (scope.departmentId !== null) {
    params.push(scope.departmentId);
    conds.push(`e.department_id = $${params.length}`);
  }
  const limit = Math.min(500, cleanInt(body.limit, 500, 1) ?? 200);
  const empRes = await c.query(
    `SELECT e.id, e.tenant_id, e.company_id, e.branch_id, e.department_id,
            e.employee_no, e.employee_number, e.short_employee_number,
            e.first_name, e.last_name, e.position, e.status
       FROM employees e
      WHERE ${conds.join(' AND ')}
      ORDER BY e.id ASC
      LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  const employees = empRes.rows as unknown as Record<string, unknown>[];

  const requestedDeviceId = parseDeviceId(body.deviceId);
  const targets = await collectTargetDevices(c, scope, requestedDeviceId);
  const doorNo = cleanInt(body.doorNo, 99, 1) ?? 1;
  const planTemplateNo = cleanStr(body.planTemplateNo, 16) ?? '1';

  const items: SyncOutcomeRow[] = [];
  for (const employee of employees) {
    const employeeId = Number(employee.id);
    const employeeCompanyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
    const cardNo =
      employeeCompanyId !== null ? await fetchActiveRfidCard(c, scope.tenantId, employeeCompanyId, employeeId) : null;
    const rows = await provisionEmployee(c, ctx, scope, employee, 'BULK_SYNC', requestedDeviceId, {
      cardNo,
      doorNo,
      planTemplateNo,
    });
    items.push(...rows);
  }
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.bulk_sync',
    resource: 'hikvision_employee_links',
    metadata: { employeeCount: employees.length, deviceCount: targets.length, summary },
  });
  return { items, summary, employeesAttempted: employees.length, deviceCount: targets.length };
}

/**
 * Deactivate an employee: ERP links are always moved to INACTIVE (source of
 * truth) and remote DISABLE commands are best-effort with logged outcomes.
 */
export async function deactivateEmployee(
  c: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  const employee = await fetchEmployee(c, scope, employeeId);
  const employeeCompanyId = employee.company_id != null ? Number(employee.company_id) : scope.companyId;
  if (employeeCompanyId === null) throw badRequest('Employee is not attached to a company');

  const items = await provisionEmployee(c, ctx, scope, employee, 'DEACTIVATE_EMPLOYEE', null, {
    cardNo: null,
    doorNo: 1,
    planTemplateNo: '1',
  });
  const forced = await c.query(
    `UPDATE hikvision_employee_links
        SET status = 'INACTIVE', updated_by = $1, updated_at = now()
      WHERE tenant_id = $2 AND company_id = $3 AND employee_id = $4
        AND status <> 'INACTIVE'`,
    [ctx.userId ?? null, scope.tenantId, employeeCompanyId, employeeId]
  );
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.deactivated',
    resource: 'hikvision_employee_links',
    recordId: employeeId,
    recordCode: String(bestEmployeeNumber(employee) ?? ''),
    oldValues: { employeeStatus: employee.status },
    metadata: { linksDeactivated: forced.rowCount ?? 0, summary },
  });
  return { items, summary, linksDeactivated: forced.rowCount ?? 0 };
}

/** Disable device access (link -> SUSPENDED) when the terminal confirms it. */
export async function disableAccess(
  c: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  const employee = await fetchEmployee(c, scope, employeeId);
  const deviceId = parseDeviceId(body.deviceId);
  const items = await provisionEmployee(c, ctx, scope, employee, 'DISABLE_ACCESS', deviceId, {
    cardNo: null,
    doorNo: 1,
    planTemplateNo: '1',
  });
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.disable_access',
    resource: 'hikvision_employee_links',
    recordId: employeeId,
    recordCode: String(bestEmployeeNumber(employee) ?? ''),
    metadata: { deviceId, summary },
  });
  return { items, summary };
}

/** Remove device access entirely (link -> INACTIVE) when the terminal confirms it. */
export async function removeDeviceAccess(
  c: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx, { companyId: body.companyId, branchId: body.branchId });
  const employee = await fetchEmployee(c, scope, employeeId);
  const deviceId = parseDeviceId(body.deviceId);
  const items = await provisionEmployee(c, ctx, scope, employee, 'REMOVE_DEVICE_ACCESS', deviceId, {
    cardNo: null,
    doorNo: 1,
    planTemplateNo: '1',
  });
  const summary = summarize(items);
  await logAudit(c, ctx, {
    action: 'hikvision.employee.remove_access',
    resource: 'hikvision_employee_links',
    recordId: employeeId,
    recordCode: String(bestEmployeeNumber(employee) ?? ''),
    metadata: { deviceId, summary },
  });
  return { items, summary };
}

/** Fetch one employee<->device mapping. */
export async function getEmployeeLink(c: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const row = await fetchLink(c, scope, id);
  return { link: mapLink(row) };
}

/** Soft-delete an employee<->device mapping (INACTIVE + audit). */
export async function deleteEmployeeLink(
  c: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const scope = await resolveOrg(c, ctx);
  const link = await fetchLink(c, scope, id);
  const reason = cleanStr(body.reason, 300);
  await c.query(
    `UPDATE hikvision_employee_links
        SET status = 'INACTIVE', updated_by = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [ctx.userId ?? null, id, scope.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'hikvision.employee_link.deleted',
    resource: 'hikvision_employee_links',
    recordId: id,
    recordCode: String(link.employee_identifier ?? ''),
    oldValues: { status: link.status },
    newValues: { status: 'INACTIVE' },
    metadata: { reason },
  });
  return { link: mapLink({ ...link, status: 'INACTIVE' }), deleted: true };
}

/** Sync log journal with employee/device context. */
export async function listSyncLogs(
  c: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const scope = await resolveOrg(c, ctx, { companyId: q.companyId, branchId: q.branchId });
  const pg = pageOf(q);
  const conds: string[] = ['l.tenant_id = $1'];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`l.company_id = $${params.length}`);
  }
  if (scope.branchId !== null) {
    params.push(scope.branchId);
    conds.push(`d.branch_id = $${params.length}`);
  }
  const employeeId = cleanInt(q.employeeId);
  if (employeeId !== null) {
    params.push(employeeId);
    conds.push(`l.employee_id = $${params.length}`);
  }
  const deviceId = cleanInt(q.deviceId);
  if (deviceId !== null) {
    params.push(deviceId);
    conds.push(`l.device_id = $${params.length}`);
  }
  const action = cleanStr(q.action, 32);
  if (action) {
    if (!SYNC_ACTIONS.includes(action)) throw badRequest('Invalid sync action filter');
    params.push(action);
    conds.push(`l.action = $${params.length}`);
  }
  const status = cleanStr(q.status, 16);
  if (status) {
    if (!['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(status)) throw badRequest('Invalid sync status filter');
    params.push(status);
    conds.push(`l.status = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const totalRes = await c.query(
    `SELECT count(*)::int AS total
       FROM hikvision_sync_logs l
       LEFT JOIN hikvision_devices d ON d.id = l.device_id
      WHERE ${where}`,
    params
  );
  const rowsRes = await c.query(
    `SELECT l.*, e.employee_no, e.first_name, e.last_name, e.position,
            d.code AS device_code, d.name AS device_name, d.serial_number AS device_serial
       FROM hikvision_sync_logs l
       LEFT JOIN employees e ON e.id = l.employee_id
       LEFT JOIN hikvision_devices d ON d.id = l.device_id
      WHERE ${where}
      ORDER BY l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pg.pageSize, pg.offset]
  );
  return {
    items: rowsRes.rows.map((r) => mapSyncLog(r as unknown as Record<string, unknown>)),
    total: Number(totalRes.rows[0]?.total ?? 0),
    page: pg.page,
    pageSize: pg.pageSize,
  };
}