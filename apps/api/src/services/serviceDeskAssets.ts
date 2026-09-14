import pg from 'pg';
import { Ctx } from '../db.js';
import { findQrByCode } from './qr.js';
import {
  s,
  n,
  nn,
  truthy,
  oneOf,
  uniq,
  strList,
  hasPerm,
  nowIso,
  paged,
  type Page,
  requireRow,
  resolveScope,
  type TicketScope,
  logAudit,
  emitEvent,
  badRequest,
  forbidden,
  notFound,
  parsePagination,
  notifyUsers,
  usersWithPermission,
  sameId,
  idIn,
} from './serviceDeskCommon.js';
import {
  createTicket,
  loadTicketRow,
  loadTicketByNumber,
  addComment,
  mayActOnBehalf,
  CREATE_ON_BEHALF_PERMISSION,
} from './serviceDesk.js';

/**
 * Service Desk asset and QR integration (spec sections 12 and 13).
 *
 * A technician scans an asset tag and the platform walks the chain
 *
 *   SCAN QR -> AUTHENTICATE -> RBAC -> ABAC -> ASSET IDENTIFIED
 *           -> VIEW AUTHORIZED DETAILS -> CREATE / VIEW SERVICE TICKETS
 *
 * Two rules shape this module:
 *
 *  1. Every scan is audited, including the ones that are refused. A refusal is
 *     therefore recorded as a row in asset_service_scans and returned as data
 *     rather than thrown as an error, so the caller transaction commits and the
 *     trail survives. The route layer turns a refused scan into an HTTP 403
 *     after the row is already durable.
 *  2. The Asset Register is not the only source of truth. A QR can bind to a
 *     registered asset, to a production machine, or to a machine that also has
 *     an asset record. All three shapes resolve here.
 */

// --------------------------------------------------------------- vocabulary

/** asset_service_scans.action CHECK values. */
export const ASSET_SCAN_ACTIONS = [
  'VIEW',
  'REPORT_INCIDENT',
  'CREATE_SERVICE_REQUEST',
  'VIEW_ASSET_HISTORY',
  'VIEW_MAINTENANCE_HISTORY',
  'UPDATE_TICKET',
  'REQUEST_MAINTENANCE',
] as const;
export type AssetScanAction = (typeof ASSET_SCAN_ACTIONS)[number];

/** asset_service_scans.outcome CHECK values. */
export const ASSET_SCAN_OUTCOMES = [
  'SUCCESS',
  'DENIED_RBAC',
  'DENIED_ABAC',
  'DENIED_SCOPE',
  'ASSET_NOT_FOUND',
  'ERROR',
] as const;
export type AssetScanOutcome = (typeof ASSET_SCAN_OUTCOMES)[number];

/** Which side of the estate a scanned code binds to. */
export const ASSET_ENTITY_TYPES = ['ASSET', 'MACHINE'] as const;
export type AssetEntityType = (typeof ASSET_ENTITY_TYPES)[number];

/**
 * Permission required for each scan intent. Reading history is a read of the
 * ticket estate; raising or amending a ticket follows the ticket permissions so
 * a QR scan can never be used to bypass the Service Desk rules.
 */
export const ASSET_SCAN_PERMISSIONS: Record<AssetScanAction, string> = {
  VIEW: 'service_desk.tickets.view',
  VIEW_ASSET_HISTORY: 'service_desk.tickets.view',
  VIEW_MAINTENANCE_HISTORY: 'service_desk.tickets.view',
  REPORT_INCIDENT: 'service_desk.tickets.create',
  CREATE_SERVICE_REQUEST: 'service_desk.tickets.create',
  REQUEST_MAINTENANCE: 'service_desk.tickets.create',
  UPDATE_TICKET: 'service_desk.tickets.update',
};

/**
 * Read intents a self-service caller may also perform. The desk permission is
 * preferred whenever it is held; otherwise `view_own` is accepted, because the
 * scan payload for a non-agent already withholds custody and financial detail
 * (authorizedAssetDetails) and the organizational scope check still applies.
 * Without this, the assets.scans.scan grant that employee_self_service already
 * holds would be inert: every read scan would refuse with DENIED_RBAC.
 */
export const ASSET_SCAN_PERMISSION_ALTERNATIVES: Partial<Record<AssetScanAction, readonly string[]>> = {
  VIEW: ['service_desk.tickets.view_own'],
  VIEW_ASSET_HISTORY: ['service_desk.tickets.view_own'],
  VIEW_MAINTENANCE_HISTORY: ['service_desk.tickets.view_own'],
};

/** Every permission that authorizes this intent, strongest first. */
export function scanPermissionCandidates(action: AssetScanAction): string[] {
  return [ASSET_SCAN_PERMISSIONS[action], ...(ASSET_SCAN_PERMISSION_ALTERNATIVES[action] ?? [])];
}

/**
 * Pick the strongest permission the caller actually holds for this intent.
 * Returns null when the caller holds none of them, which is an RBAC refusal.
 *
 * The chosen code - not the intent's primary code - travels into the ABAC
 * resource attributes, so a self-service scan is evaluated as `view_own` and
 * a desk scan as `view`.
 */
export function chooseScanPermission(
  scope: TicketScope,
  action: AssetScanAction
): { permission: string; viaOwn: boolean } | null {
  if (scope.isAdmin) return { permission: ASSET_SCAN_PERMISSIONS[action], viaOwn: false };
  const candidates = scanPermissionCandidates(action);
  for (let i = 0; i < candidates.length; i += 1) {
    if (hasPerm(scope.permissions, candidates[i])) {
      return { permission: candidates[i], viaOwn: i > 0 };
    }
  }
  return null;
}

/**
 * Intents a same-branch caller may perform on shared equipment. Reading is
 * obviously one of them; so is asking for help. Reporting a fault or raising a
 * request does not mutate the asset and still travels the full ticket pipeline
 * (self-service identity, queue, SLA, audit), so refusing it would only stop
 * the desk from learning that a shared printer is broken. Amending an existing
 * ticket (UPDATE_TICKET) deliberately stays narrow.
 */
const BRANCH_TOLERANT_ACTIONS: readonly AssetScanAction[] = [
  'VIEW',
  'VIEW_ASSET_HISTORY',
  'VIEW_MAINTENANCE_HISTORY',
  'REPORT_INCIDENT',
  'CREATE_SERVICE_REQUEST',
  'REQUEST_MAINTENANCE',
];

/**
 * Ticket type produced by each raising intent, so a scan from the shop floor
 * lands in the right workflow without the client having to know the taxonomy.
 */
export const ASSET_SCAN_TICKET_TYPE: Partial<Record<AssetScanAction, string>> = {
  REPORT_INCIDENT: 'INCIDENT',
  CREATE_SERVICE_REQUEST: 'SERVICE_REQUEST',
  REQUEST_MAINTENANCE: 'MAINTENANCE_REQUEST',
};

/** Field-level authorization gate for commercially sensitive asset columns. */
const ASSET_FINANCIAL_PERMISSION = 'assets.register.view';

// ------------------------------------------------------------- type shapes

export interface AssetIdentityDetail {
  entityType: AssetEntityType;
  /** asset_register row id, or null when the QR binds only to a machine. */
  assetId: number | null;
  /** machines row id, or null for a plain asset. */
  machineId: number | null;
  assetNo: string;
  name: string;
  status: string | null;
  condition: string | null;
  operationalState: string | null;
  categoryName: string | null;
  locationName: string | null;
  departmentId: number | null;
  branchId: number | null;
  isMachine: boolean;
  /**
   * Common plant rather than departmental property: a production machine, a
   * floor printer, an attendance terminal. These carry neither a department nor
   * a branch, so the departmental rule below can never reach them.
   */
  sharedEquipment: boolean;
  /** Secure or high value equipment: scanning it needs a clearance. */
  isSecure: boolean;
  custodianUserId: number | null;
  custodianEmployeeId: number | null;
  custodianName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  maintenanceStatus: string | null;
  nextMaintenanceDate: string | null;
  qrId: number | null;
  qrValue: string | null;
  qrStatus: string | null;
  lastScanAt: string | null;
  lastVerifiedAt: string | null;
}

export interface AssetIdentity {
  detail: AssetIdentityDetail;
  /** Raw source row so callers can reach columns the detail shape omits. */
  raw: Record<string, unknown>;
  qr: Record<string, unknown> | null;
}

// ------------------------------------------------------------------ helpers

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v);
  return t === '' ? null : t;
};

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const t = String(v);
  return t === '' ? null : t;
};

const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';

/** Normalize a scanned value: technicians paste tag numbers, often with spaces. */
const normalizeCode = (v: unknown): string | null => {
  const t = s(v);
  return t ? t.toUpperCase().replace(/\s+/g, '') : null;
};

export function assetScanAction(v: unknown): AssetScanAction {
  return oneOf(v ?? 'VIEW', ASSET_SCAN_ACTIONS) ?? 'VIEW';
}

/** A display name for a user, falling back to the email local part. */
async function displayName(client: pg.PoolClient, userId: number | null): Promise<string | null> {
  if (!userId) return null;
  const res = await client.query<{ name: string | null }>(
    `SELECT COALESCE(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''), email) AS name
       FROM users WHERE id = $1`,
    [userId]
  );
  return str(res.rows[0]?.name);
}

// ------------------------------------------------------- identity resolution

const ASSET_COLUMNS = `
  a.id, a.asset_no, a.name, a.status, a.condition, a.operational_state,
  a.department_id, a.branch_id, a.location_id, a.custodian_user_id, a.custodian_employee_id,
  a.manufacturer, a.model, a.serial_no, a.qr_id, a.is_machine, a.is_high_value,
  a.maintenance_status, a.next_maintenance, a.last_scan_at, a.last_verified_at,
  a.purchase_cost, a.current_book_value, a.currency, a.warranty_status, a.supplier_id,
  al.name AS location_name, ac.name AS category_name
`;

/** Load a registered asset by primary key. */
async function loadAssetById(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT ${ASSET_COLUMNS}
       FROM asset_register a
       LEFT JOIN asset_locations al ON al.id = a.location_id
       LEFT JOIN asset_categories ac ON ac.id = a.category_id
      WHERE a.id = $1 AND a.tenant_id = $2 AND COALESCE(a.is_deleted, false) = false`,
    [id, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

/** Load a registered asset by its bound QR id. */
async function loadAssetByQr(
  client: pg.PoolClient,
  ctx: Ctx,
  qrId: number
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT ${ASSET_COLUMNS}
       FROM asset_register a
       LEFT JOIN asset_locations al ON al.id = a.location_id
       LEFT JOIN asset_categories ac ON ac.id = a.category_id
      WHERE a.qr_id = $1 AND a.tenant_id = $2 AND COALESCE(a.is_deleted, false) = false
      ORDER BY a.id
      LIMIT 1`,
    [qrId, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

/** Load a registered asset by human-readable keys (tag number or asset number). */
async function loadAssetByNumber(
  client: pg.PoolClient,
  ctx: Ctx,
  value: string
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT ${ASSET_COLUMNS}
       FROM asset_register a
       LEFT JOIN asset_locations al ON al.id = a.location_id
       LEFT JOIN asset_categories ac ON ac.id = a.category_id
      WHERE a.tenant_id = $1
        AND (upper(a.asset_no) = $2 OR upper(COALESCE(a.barcode, '')) = $2
             OR EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND upper(t.tag_no) = $2))
        AND COALESCE(a.is_deleted, false) = false
      ORDER BY a.id
      LIMIT 1`,
    [ctx.tenantId, value]
  );
  return res.rows[0] ?? null;
}

/** Load a production machine by its bound QR id. */
async function loadMachineByQr(
  client: pg.PoolClient,
  ctx: Ctx,
  qrId: number
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT m.*, w.name AS work_centre_name
       FROM machines m
       LEFT JOIN work_centres w ON w.id = m.work_centre_id
      WHERE m.qr_id = $1 AND m.tenant_id = $2
        AND (m.company_id IS NULL OR m.company_id = $3)
      ORDER BY m.id
      LIMIT 1`,
    [qrId, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

/** Load a production machine by its code, for manually typed tag numbers. */
async function loadMachineByCode(
  client: pg.PoolClient,
  ctx: Ctx,
  value: string
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT m.*, w.name AS work_centre_name
       FROM machines m
       LEFT JOIN work_centres w ON w.id = m.work_centre_id
      WHERE m.tenant_id = $1 AND upper(m.code) = $2
        AND (m.company_id IS NULL OR m.company_id = $3)
      ORDER BY m.id
      LIMIT 1`,
    [ctx.tenantId, value, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

/**
 * Resolve whatever a technician scanned into an asset identity. Accepts a QR
 * code, an asset number, a tag number or a machine code, and follows a machine
 * back to its registered asset when the two records are linked.
 */
export async function resolveAssetIdentity(
  client: pg.PoolClient,
  ctx: Ctx,
  scanned: unknown
): Promise<AssetIdentity | null> {
  const code = normalizeCode(scanned);
  if (!code) return null;

  const qr = (await findQrByCode(client, ctx, code)) as Record<string, unknown> | null;
  const qrId = qr ? n(qr.id) ?? null : null;

  let assetRow: Record<string, unknown> | null = null;
  let machineRow: Record<string, unknown> | null = null;

  if (qrId) {
    assetRow = await loadAssetByQr(client, ctx, qrId);
    if (!assetRow) machineRow = await loadMachineByQr(client, ctx, qrId);
  }
  if (!assetRow && !machineRow) {
    assetRow = await loadAssetByNumber(client, ctx, code);
    if (!assetRow) machineRow = await loadMachineByCode(client, ctx, code);
  }
  if (!assetRow && !machineRow) return null;

  // A machine may point at an asset record; prefer it so tickets raised from the
  // shop floor land on the same asset the finance register knows about.
  let machineId: number | null = machineRow ? n(machineRow.id) ?? null : null;
  if (machineRow && !assetRow) {
    const linked = n(machineRow.asset_id);
    if (linked) assetRow = await loadAssetById(client, ctx, linked);
  }

  const custodianUserId =
    (assetRow ? n(assetRow.custodian_user_id) ?? null : null) ?? null;
  const custodianEmployeeId =
    (assetRow ? n(assetRow.custodian_employee_id) ?? null : null) ?? null;

  const isMachine = bool(assetRow?.is_machine) || machineRow !== null;
  const isSecure = isMachine
    ? bool(machineRow?.is_secure)
    : bool(assetRow?.is_high_value);

  const entityType: AssetEntityType = machineRow !== null && !assetRow ? 'MACHINE' : 'ASSET';

  // Ownership anchor. A registered asset names its department and branch; plant
  // equipment - a machine, or an asset the register has not placed - carries
  // neither, which is exactly what makes it common equipment rather than
  // departmental property.
  const departmentId = assetRow ? n(assetRow.department_id) ?? null : null;
  const branchId = assetRow ? n(assetRow.branch_id) ?? null : null;
  const sharedEquipment = departmentId === null && branchId === null;

  const detail: AssetIdentityDetail = {
    entityType,
    assetId: assetRow ? n(assetRow.id) ?? null : null,
    machineId,
    assetNo: str(assetRow?.asset_no) ?? str(machineRow?.code) ?? code,
    name: str(assetRow?.name) ?? str(machineRow?.name) ?? code,
    status: str(assetRow?.status) ?? str(machineRow?.status),
    condition: str(assetRow?.condition),
    operationalState: str(assetRow?.operational_state) ?? str(machineRow?.machine_state),
    categoryName: str(assetRow?.category_name),
    locationName: str(assetRow?.location_name) ?? str(machineRow?.location) ?? str(machineRow?.work_centre_name),
    departmentId,
    branchId,
    isMachine,
    sharedEquipment,
    isSecure,
    custodianUserId,
    custodianEmployeeId,
    custodianName: custodianUserId ? await displayName(client, custodianUserId) : null,
    manufacturer: str(assetRow?.manufacturer) ?? str(machineRow?.make),
    model: str(assetRow?.model) ?? str(machineRow?.model),
    serialNo: str(assetRow?.serial_no) ?? str(machineRow?.serial_no),
    maintenanceStatus: str(assetRow?.maintenance_status) ?? str(machineRow?.maintenance_status),
    nextMaintenanceDate: iso(assetRow?.next_maintenance),
    qrId: qrId,
    qrValue: str(qr?.code) ?? code,
    qrStatus: str(qr?.status),
    lastScanAt: iso(assetRow?.last_scan_at) ?? iso(qr?.last_scan_at),
    lastVerifiedAt: iso(assetRow?.last_verified_at),
  };

  return { detail, raw: assetRow ?? machineRow ?? {}, qr };
}

/** Machine-only columns used by the maintenance history view. */
export async function machineRuntime(
  client: pg.PoolClient,
  ctx: Ctx,
  machineId: number
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT id, code, name, machine_state, production_hours, downtime_hours,
            maintenance_status, location, status
       FROM machines WHERE id = $1 AND tenant_id = $2`,
    [machineId, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

// ------------------------------------------------------- authorization model

export interface AssetScopeDecision {
  /** True when the scanned asset sits inside the caller's reach. */
  inScope: boolean;
  /** True when the caller is the named custodian of the equipment. */
  isCustodian: boolean;
  /** Human-readable justification recorded on a refusal. */
  reason: string | null;
}

/**
 * Organizational reach for a single asset. Multi-company isolation is already
 * enforced in SQL; this widens or narrows within one company:
 *
 *   administrator        -> everything
 *   custodian            -> the equipment they are accountable for
 *   own department       -> the department's shared equipment
 *   agent, unrestricted  -> the whole company desk
 *   same branch (reads)  -> shared equipment such as printers and terminals
 */
export function assetScopeDecision(
  scope: TicketScope,
  detail: AssetIdentityDetail,
  action: AssetScanAction
): AssetScopeDecision {
  if (scope.isAdmin) return { inScope: true, isCustodian: false, reason: null };

  const isCustodian =
    sameId(detail.custodianUserId, scope.userId) ||
    sameId(detail.custodianEmployeeId, scope.employeeId);
  if (isCustodian) return { inScope: true, isCustodian: true, reason: null };

  if (detail.departmentId !== null) {
    if (idIn(scope.departmentIds, detail.departmentId)) {
      return { inScope: true, isCustodian: false, reason: null };
    }
    if (sameId(detail.departmentId, scope.departmentId)) {
      return { inScope: true, isCustodian: false, reason: null };
    }
  }

  if (scope.isAgent && scope.queueIds === null) {
    return { inScope: true, isCustodian: false, reason: null };
  }

  const branchTolerant = BRANCH_TOLERANT_ACTIONS.includes(action);
  if (branchTolerant && detail.sharedEquipment) {
    return { inScope: true, isCustodian: false, reason: null };
  }
  if (branchTolerant && sameId(detail.branchId, scope.branchId)) {
    return { inScope: true, isCustodian: false, reason: null };
  }

  return {
    inScope: false,
    isCustodian: false,
    reason: 'Asset ' + detail.assetNo + ' is outside your authorized organizational scope',
  };
}

/**
 * Facts published to the ABAC engine. Assign this to req.ctx.resourceAttributes
 * before the route re-runs requirePermission so the first matching policy sees
 * the real asset, not a bare permission string.
 */
export function assetResourceAttributes(
  scope: TicketScope,
  detail: AssetIdentityDetail,
  action: AssetScanAction,
  decision: AssetScopeDecision,
  permissionOverride?: string
): Record<string, unknown> {
  // The ABAC engine spreads resourceAttributes over the derived resource, so
  // the key 'action' must stay the lowercase permission verb. The scan intent
  // travels separately as 'scan_action'.
  const attrs: Record<string, unknown> = {
    module: 'service_desk',
    resource: 'asset_scans',
    action: (permissionOverride ?? ASSET_SCAN_PERMISSIONS[action]).split('.')[2],
    scan_action: action,
    asset_id: detail.assetId,
    machine_id: detail.machineId,
    asset_no: detail.assetNo,
    entity_type: detail.entityType,
    department_id: detail.departmentId,
    branch_id: detail.branchId,
    custodian_user_id: detail.custodianUserId,
    is_machine: detail.isMachine,
    is_secure: detail.isSecure,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
    // ABAC-SD-ASSET-SECURE (migration 0156) denies when a secure asset is
    // scanned without a security clearance. The key is always published as a
    // boolean because the policy matches on true; the policy also requires the
    // subject to be uncleared, so a caller-controlled fact cannot defeat it.
    secure_asset_denied: detail.isSecure && !scope.securityClearance,
  };
  if (!decision.inScope) attrs.scope_denied = true;
  return attrs;
}

/**
 * Authorized detail payload. Everything the technician is allowed to see after
 * the scan, with financial columns withheld unless they hold the asset register
 * permission.
 */
export function authorizedAssetDetails(
  detail: AssetIdentityDetail,
  scope: TicketScope,
  raw: Record<string, unknown> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    entityType: detail.entityType,
    assetId: detail.assetId,
    machineId: detail.machineId,
    assetNo: detail.assetNo,
    name: detail.name,
    status: detail.status,
    condition: detail.condition,
    operationalState: detail.operationalState,
    categoryName: detail.categoryName,
    locationName: detail.locationName,
    departmentId: detail.departmentId,
    isMachine: detail.isMachine,
    isSecure: detail.isSecure,
    manufacturer: detail.manufacturer,
    model: detail.model,
    serialNo: detail.serialNo,
    maintenanceStatus: detail.maintenanceStatus,
    nextMaintenanceDate: detail.nextMaintenanceDate,
    qr: { id: detail.qrId, value: detail.qrValue, status: detail.qrStatus },
    lastScanAt: detail.lastScanAt,
    lastVerifiedAt: detail.lastVerifiedAt,
  };

  // Custody is personal data: only agents and administrators see who holds it.
  if (scope.isAgent || scope.isAdmin) {
    base.custodianEmployeeId = detail.custodianEmployeeId;
    base.custodianUserId = detail.custodianUserId;
    base.custodianName = detail.custodianName;
    base.branchId = detail.branchId;
  }

  if (scope.isAdmin || hasPerm(scope.permissions, ASSET_FINANCIAL_PERMISSION)) {
    base.financial = {
      purchaseCost: n(raw.purchase_cost) ?? null,
      currentBookValue: n(raw.current_book_value) ?? null,
      currency: str(raw.currency),
      warrantyStatus: str(raw.warranty_status),
      supplierId: n(raw.supplier_id) ?? null,
    };
  }

  return base;
}

// ------------------------------------------------------------- scan logging

export interface AssetScanRecord {
  action: AssetScanAction;
  outcome: AssetScanOutcome;
  denyReason?: string | null;
  detail?: AssetIdentityDetail | null;
  qrId?: number | null;
  qrValue?: string | null;
  ticketId?: number | null;
  assetId?: number | null;
  scannedByEmployeeId?: number | null;
  device?: string | null;
  ip?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append one row to asset_service_scans. Called once per scan attempt, before
 * any authorization outcome is returned, so refusals leave the same trail as
 * successes. Never swallows a failure silently: the caller decides.
 */
export async function recordAssetScan(
  client: pg.PoolClient,
  ctx: Ctx,
  record: AssetScanRecord
): Promise<number> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO asset_service_scans
       (tenant_id, company_id, branch_id, scanned_by, scanned_by_employee_id,
        qr_code_id, qr_value, asset_id, asset_no, action, outcome, deny_reason,
        ticket_id, device, ip, gps_lat, gps_lng, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      ctx.userId ?? null,
      record.scannedByEmployeeId ?? null,
      record.qrId ?? null,
      record.qrValue ?? null,
      record.assetId ?? null,
      record.detail?.assetNo ?? null,
      record.action,
      record.outcome,
      record.denyReason ?? null,
      record.ticketId ?? null,
      record.device ?? ctx.device ?? null,
      record.ip ?? ctx.ip ?? null,
      record.gpsLat ?? null,
      record.gpsLng ?? null,
      JSON.stringify(record.metadata ?? {}),
    ]
  );
  const scanId = Number(res.rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'service_desk.asset_scanned',
    entityType: 'asset_service_scans',
    entityId: scanId,
    entityCode: record.detail?.assetNo ?? record.qrValue ?? null,
    payload: { action: record.action, outcome: record.outcome, ticketId: record.ticketId ?? null },
    severity: record.outcome === 'SUCCESS' ? 'INFO' : 'WARN',
  });
  return scanId;
}

// ------------------------------------------------------- the scan entrypoint

export interface AssetScanRequest {
  code?: unknown;
  action?: unknown;
  device?: unknown;
  secret?: unknown;
  gpsLat?: unknown;
  gpsLng?: unknown;
  note?: unknown;
}

export interface AssetScanPreparation {
  scanId: number;
  action: AssetScanAction;
  /** SUCCESS here means "cleared RBAC and organizational scope". */
  outcome: AssetScanOutcome;
  allowed: boolean;
  denyReason: string | null;
  /** Permission the route must re-check with the published ABAC facts. */
  permission: string;
  /** Assign to req.ctx.resourceAttributes before re-authorizing. */
  attributes: Record<string, unknown>;
  asset: Record<string, unknown> | null;
  detail: AssetIdentityDetail | null;
  scope: TicketScope;
  code: string;
  qr: Record<string, unknown> | null;
}

const scanCode = (b: Record<string, unknown>): string | null =>
  normalizeCode(b.code ?? b.qr ?? b.qrCode ?? b.qr_code ?? b.tag ?? b.tagNo ?? b.assetNo ?? b.asset_no ?? b.value);

/**
 * Step one of a scan: identify the asset, run RBAC and the organizational scope
 * check, publish the ABAC facts and write the audit row. Whatever the outcome,
 * the row is written first so a refusal is as traceable as a success.
 *
 * The caller must then assign `attributes` to req.ctx.resourceAttributes and
 * re-run requirePermission(permission) so the ABAC engine makes the final call.
 */
export async function prepareAssetScan(
  client: pg.PoolClient,
  ctx: Ctx,
  b: Record<string, unknown>
): Promise<AssetScanPreparation> {
  const code = scanCode(b);
  if (!code) throw badRequest('A QR code, asset number or tag number is required');
  const action = assetScanAction(b.action);
  const device = s(b.device) ?? ctx.device ?? null;
  const gpsLat = n(b.gpsLat) ?? n(b.gps_lat) ?? null;
  const gpsLng = n(b.gpsLng) ?? n(b.gps_lng) ?? null;
  const note = s(b.note) ?? null;

  const scope = await resolveScope(client, ctx);

  // The permission recorded, audited and published is the one the caller
  // actually exercised: `view` for desk staff, `view_own` for a self-service
  // scan. ABAC therefore classifies the request correctly.
  const chosen = chooseScanPermission(scope, action);
  const permission = chosen?.permission ?? ASSET_SCAN_PERMISSIONS[action];

  /** Every audited attempt goes through here, so no outcome can skip the trail. */
  const write = (
    outcome: AssetScanOutcome,
    denyReason: string | null,
    detail: AssetIdentityDetail | null,
    qr: Record<string, unknown> | null
  ): AssetScanRecord => {
    const qrId = detail?.qrId ?? (qr ? n(qr.id) ?? null : null);
    const qrValue = detail?.qrValue ?? (qr ? str(qr.code) : null) ?? code;
    return {
      action,
      outcome,
      denyReason,
      detail,
      qrId,
      qrValue,
      assetId: detail?.assetId ?? null,
      device,
      ip: ctx.ip ?? null,
      gpsLat,
      gpsLng,
      scannedByEmployeeId: scope.employeeId,
      metadata: { permission, note },
    };
  };

  /** Record the attempt and build the caller-facing envelope. */
  const refused = async (
    outcome: AssetScanOutcome,
    denyReason: string,
    detail: AssetIdentityDetail | null,
    qr: Record<string, unknown> | null
  ): Promise<AssetScanPreparation> => {
    const scanId = await recordAssetScan(client, ctx, write(outcome, denyReason, detail, qr));
    return {
      scanId,
      action,
      outcome,
      allowed: false,
      denyReason,
      permission,
      attributes: detail ? assetResourceAttributes(scope, detail, action, { inScope: true, isCustodian: false, reason: null }, permission) : {},
      asset: null,
      detail,
      scope,
      code,
      qr,
    };
  };

  // RBAC ? the actor must hold the permission the intent maps to.
  if (!chosen) {
    return refused(
      'DENIED_RBAC',
      'Missing permission: ' + scanPermissionCandidates(action).join(' or '),
      null,
      null
    );
  }

  // AUTHENTICATE ? a QR that carries a secret must present it.
  const identity = await resolveAssetIdentity(client, ctx, code);
  if (!identity) {
    const orphanQr = (await findQrByCode(client, ctx, code)) as Record<string, unknown> | null;
    return refused('ASSET_NOT_FOUND', 'No asset or machine is registered for ' + code, null, orphanQr);
  }

  const qr = identity.qr;
  if (qr && s(b.secret)) {
    const { createHash } = await import('node:crypto');
    const provided = createHash('sha256').update(String(b.secret)).digest('hex');
    if (provided !== String(qr.secret_hash ?? '')) {
      return refused('DENIED_RBAC', 'QR credential does not match this tag', identity.detail, qr);
    }
  }

  // ABAC / scope ? the asset must sit inside the caller's reach.
  const decision = assetScopeDecision(scope, identity.detail, action);
  if (!decision.inScope) {
    return refused('DENIED_SCOPE', decision.reason ?? 'Asset is outside your authorized scope', identity.detail, qr);
  }

  const attributes = assetResourceAttributes(scope, identity.detail, action, decision, permission);
  const scanId = await recordAssetScan(client, ctx, write('SUCCESS', null, identity.detail, qr));

  return {
    scanId,
    action,
    outcome: 'SUCCESS',
    allowed: true,
    denyReason: null,
    permission,
    attributes,
    asset: authorizedAssetDetails(identity.detail, scope, identity.raw),
    detail: identity.detail,
    scope,
    code,
    qr,
  };
}

/** Mark a scan row that could not complete, so failures are never invisible. */
export async function failAssetScan(
  client: pg.PoolClient,
  ctx: Ctx,
  prep: AssetScanPreparation,
  reason: string,
  outcome: AssetScanOutcome = 'DENIED_ABAC'
): Promise<void> {
  await client.query(
    `UPDATE asset_service_scans
        SET outcome = $1, deny_reason = $2, updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [outcome, reason.slice(0, 500), prep.scanId, ctx.tenantId]
  );
  await logAudit(client, ctx, {
    action: 'scan_refused',
    resource: 'service_desk.asset_scans',
    recordId: prep.scanId,
    recordCode: prep.detail?.assetNo ?? prep.code,
    metadata: { action: prep.action, outcome, reason },
  });
}

/** Attach the ticket a scan produced to its audit row. */
async function attachScanTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  scanId: number,
  ticketId: number
): Promise<void> {
  await client.query(
    `UPDATE asset_service_scans SET ticket_id = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [ticketId, scanId, ctx.tenantId]
  );
}

// ----------------------------------------------------------------- history

export interface AssetRef {
  assetId: number | null;
  machineId: number | null;
  assetNo: string;
  name: string;
  entityType: AssetEntityType;
}

/**
 * Resolve a loose asset reference (id, machine id, asset number, tag number or
 * QR value) into the ids the history queries need.
 */
export async function resolveAssetRef(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: unknown
): Promise<AssetRef> {
  const raw = s(ref);
  if (!raw) throw badRequest('An asset reference is required');

  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const asset = await loadAssetById(client, ctx, id);
    if (asset) {
      return {
        assetId: n(asset.id) ?? id,
        machineId: null,
        assetNo: str(asset.asset_no) ?? String(id),
        name: str(asset.name) ?? String(id),
        entityType: 'ASSET',
      };
    }
    const machine = await machineRuntime(client, ctx, id);
    if (machine) {
      return {
        assetId: null,
        machineId: n(machine.id) ?? id,
        assetNo: str(machine.code) ?? String(id),
        name: str(machine.name) ?? String(id),
        entityType: 'MACHINE',
      };
    }
    throw notFound('Asset not found');
  }

  const identity = await resolveAssetIdentity(client, ctx, raw);
  if (!identity) throw notFound('Asset not found');
  return {
    assetId: identity.detail.assetId,
    machineId: identity.detail.machineId,
    assetNo: identity.detail.assetNo,
    name: identity.detail.name,
    entityType: identity.detail.entityType,
  };
}

/** SQL predicate matching the tickets raised against one asset or machine. */
function ticketAssetFilter(ref: AssetRef, params: unknown[], alias = 't'): string {
  const parts: string[] = [];
  if (ref.assetId !== null) {
    params.push(ref.assetId);
    parts.push(alias + '.affected_asset_id = $' + String(params.length));
  }
  if (ref.machineId !== null) {
    params.push(String(ref.machineId));
    parts.push("(" + alias + ".device_info->>'machineId') = $" + String(params.length));
  }
  if (parts.length === 0) {
    params.push(ref.assetNo);
    parts.push(alias + ".device_info->>'assetNo' = $" + String(params.length));
  }
  return '(' + parts.join(' OR ') + ')';
}

export interface ListAssetScansQuery {
  assetId?: number | null;
  machineId?: number | null;
  ticketId?: number | null;
  action?: string | null;
  outcome?: string | null;
  scannedBy?: number | null;
  /** Force the caller-own filter even for an agent (the portal view). */
  scannedByMe?: boolean;
  denialOnly?: boolean;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

/** Paged scan ledger, newest first. Denials are first-class rows here. */
export async function listAssetScans(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ListAssetScansQuery
): Promise<Page<Record<string, unknown>>> {
  const { page, pageSize: limit, offset } = parsePagination(q as Record<string, unknown>);
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'sc.tenant_id = $1 AND sc.company_id = $2';

  // Row-level scope. A scan row carries the asset number, the GPS fix, the
  // device and the denial reason, so a caller who is not a service desk agent
  // may only ever see their own scans. Without this the employee portal would
  // hand every employee the whole company scan history.
  const scope = await resolveScope(client, ctx);
  if (q.scannedByMe === true || !scope.isAgent) {
    const mine: string[] = [];
    if (scope.userId !== null) {
      params.push(scope.userId);
      mine.push('sc.scanned_by = $' + String(params.length));
    }
    if (scope.employeeId !== null) {
      params.push(scope.employeeId);
      mine.push('sc.scanned_by_employee_id = $' + String(params.length));
    }
    // A caller with no user and no employee record owns nothing.
    where += mine.length > 0 ? ' AND (' + mine.join(' OR ') + ')' : ' AND false';
  }

  if (q.assetId) {
    params.push(q.assetId);
    where += ' AND sc.asset_id = $' + String(params.length);
  }
  if (q.ticketId) {
    params.push(q.ticketId);
    where += ' AND sc.ticket_id = $' + String(params.length);
  }
  if (q.action && oneOf(q.action, ASSET_SCAN_ACTIONS)) {
    params.push(oneOf(q.action, ASSET_SCAN_ACTIONS));
    where += ' AND sc.action = $' + String(params.length);
  }
  if (q.outcome && oneOf(q.outcome, ASSET_SCAN_OUTCOMES)) {
    params.push(oneOf(q.outcome, ASSET_SCAN_OUTCOMES));
    where += ' AND sc.outcome = $' + String(params.length);
  }
  if (q.scannedBy) {
    params.push(q.scannedBy);
    where += ' AND sc.scanned_by = $' + String(params.length);
  }
  if (q.denialOnly === true) {
    where += " AND sc.outcome <> 'SUCCESS'";
  }
  if (q.from) {
    params.push(q.from);
    where += ' AND sc.created_at >= $' + String(params.length) + '::timestamptz';
  }
  if (q.to) {
    params.push(q.to);
    where += ' AND sc.created_at <= $' + String(params.length) + '::timestamptz';
  }
  const search = s(q.search);
  if (search) {
    params.push('%' + search + '%');
    const p = '$' + String(params.length);
    where += ' AND (sc.asset_no ILIKE ' + p + ' OR sc.qr_value ILIKE ' + p + ' OR sc.deny_reason ILIKE ' + p + ')';
  }

  const totalRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM asset_service_scans sc WHERE ${where}`,
    params
  );
  const total = Number(totalRes.rows[0]?.count ?? 0);

  const listParams = params.slice();
  listParams.push(limit, offset);
  const rows = await client.query(
    `SELECT sc.*,
            u.first_name || ' ' || u.last_name AS scanned_by_name,
            t.ticket_number, t.subject AS ticket_subject
       FROM asset_service_scans sc
       LEFT JOIN users u ON u.id = sc.scanned_by
       LEFT JOIN service_tickets t ON t.id = sc.ticket_id
      WHERE ${where}
      ORDER BY sc.created_at DESC, sc.id DESC
      LIMIT $${String(listParams.length - 1)} OFFSET $${String(listParams.length)}`,
    listParams
  );

  return paged(rows.rows, total, page, limit, offset);
}

/** Paged tickets raised against one asset, newest first. */
export async function listAssetTickets(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: AssetRef,
  q: Record<string, unknown>
): Promise<Page<Record<string, unknown>>> {
  const { page, pageSize: limit, offset } = parsePagination(q);
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const filter = ticketAssetFilter(ref, params, 't');
  params.push(limit, offset);
  const limitP = '$' + String(params.length - 1);
  const offsetP = '$' + String(params.length);

  const totalRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2 AND ${filter}`,
    params.slice(0, params.length - 2)
  );
  const total = Number(totalRes.rows[0]?.count ?? 0);

  const rows = await client.query(
    `SELECT t.id, t.ticket_number, t.ticket_type, t.subject, t.status, t.priority,
            t.opened_at, t.resolved_at, t.closed_at, t.assigned_to_user_id,
            u.first_name || ' ' || u.last_name AS assigned_to_name
       FROM service_tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
      WHERE t.tenant_id = $1 AND t.company_id = $2 AND ${filter}
      ORDER BY t.opened_at DESC, t.id DESC
      LIMIT ${limitP} OFFSET ${offsetP}`,
    params
  );

  return paged(rows.rows, total, page, limit, offset);
}

export interface AssetMaintenanceHistory {
  asset: AssetRef;
  machineRuntime: Record<string, unknown> | null;
  workOrders: Record<string, unknown>[];
  maintenanceLogs: Record<string, unknown>[];
  totals: { workOrders: number; downtimeHours: number; cost: number; nextMaintenanceDate: string | null };
}

/** Maintenance record for an asset or machine: work orders plus the legacy log. */
export async function assetMaintenanceHistory(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: AssetRef
): Promise<AssetMaintenanceHistory> {
  const workOrders: Record<string, unknown>[] = [];
  if (ref.assetId !== null) {
    const res = await client.query(
      `SELECT w.id, w.wo_no, w.maintenance_type, w.priority, w.status,
              w.scheduled_date, w.completed_date, w.cost, w.downtime_hours,
              w.description, w.next_maintenance_date,
              u.first_name || ' ' || u.last_name AS technician_name
         FROM asset_maintenance_work_orders w
         LEFT JOIN users u ON u.id = w.technician_user_id
        WHERE w.tenant_id = $1 AND w.company_id = $2 AND w.asset_id = $3
        ORDER BY COALESCE(w.completed_date, w.scheduled_date, w.created_at::date) DESC, w.id DESC
        LIMIT 200`,
      [ctx.tenantId, ctx.companyId, ref.assetId]
    );
    workOrders.push(...res.rows);
  }

  const maintenanceLogs: Record<string, unknown>[] = [];
  if (ref.assetId !== null) {
    const res = await client.query(
      `SELECT id, maintenance_type, maintenance_date, cost, description, performed_by, status
         FROM asset_maintenance
        WHERE asset_id = $1
        ORDER BY maintenance_date DESC NULLS LAST, id DESC
        LIMIT 200`,
      [ref.assetId]
    );
    maintenanceLogs.push(...res.rows);
  }

  const machine = ref.machineId !== null ? await machineRuntime(client, ctx, ref.machineId) : null;

  let downtime = 0;
  let cost = 0;
  for (const wo of workOrders) {
    downtime += n(wo.downtime_hours) ?? 0;
    cost += n(wo.cost) ?? 0;
  }
  for (const log of maintenanceLogs) cost += n(log.cost) ?? 0;

  const nextDates = workOrders
    .map((wo) => str(wo.next_maintenance_date))
    .filter((v): v is string => v !== null)
    .sort();

  return {
    asset: ref,
    machineRuntime: machine,
    workOrders,
    maintenanceLogs,
    totals: {
      workOrders: workOrders.length,
      downtimeHours: Math.round(downtime * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      nextMaintenanceDate: nextDates[0] ?? null,
    },
  };
}

export interface AssetServiceHistory {
  asset: AssetRef;
  tickets: { open: number; total: number; last30Days: number };
  inspections: { lastScanAt: string | null; lastVerifiedAt: string | null; scans: number; denials: number };
  recentTickets: Record<string, unknown>[];
  recentScans: Record<string, unknown>[];
  maintenance: { workOrders: number; lastCompletedAt: string | null };
}

/** The 360 view a technician gets after scanning: tickets, scans, maintenance. */
export async function assetServiceHistory(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: AssetRef
): Promise<AssetServiceHistory> {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const filter = ticketAssetFilter(ref, params, 't');

  const ticketStats = await client.query<{ total: string; open: string; recent: string; last_closed: string | null }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE t.status NOT IN ('RESOLVED','CLOSED','CANCELLED'))::text AS open,
            count(*) FILTER (WHERE t.opened_at >= now() - interval '30 days')::text AS recent,
            max(COALESCE(t.closed_at, t.resolved_at))::text AS last_closed
       FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2 AND ${filter}`,
    params
  );

  const scanParams: unknown[] = [ctx.tenantId, ctx.companyId];
  let scanWhere = 'sc.tenant_id = $1 AND sc.company_id = $2';
  if (ref.assetId !== null) {
    scanParams.push(ref.assetId);
    scanWhere += ' AND sc.asset_id = $' + String(scanParams.length);
  } else if (ref.assetNo) {
    scanParams.push(ref.assetNo);
    scanWhere += ' AND sc.asset_no = $' + String(scanParams.length);
  }
  const scanStats = await client.query<{ total: string; denials: string; last_scan: string | null }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE sc.outcome <> 'SUCCESS')::text AS denials,
            max(sc.created_at)::text AS last_scan
       FROM asset_service_scans sc
      WHERE ${scanWhere}`,
    scanParams
  );

  const recentTickets = await client.query(
    `SELECT t.id, t.ticket_number, t.ticket_type, t.subject, t.status, t.priority, t.opened_at
       FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2 AND ${filter}
      ORDER BY t.opened_at DESC, t.id DESC
      LIMIT 10`,
    params
  );

  const recentScans = await client.query(
    `SELECT sc.id, sc.action, sc.outcome, sc.deny_reason, sc.ticket_id, sc.created_at,
            sc.qr_value, sc.asset_no
       FROM asset_service_scans sc
      WHERE ${scanWhere}
      ORDER BY sc.created_at DESC, sc.id DESC
      LIMIT 20`,
    scanParams
  );

  const maintenance = await assetMaintenanceHistory(client, ctx, ref);
  const completed = maintenance.workOrders
    .map((wo) => str(wo.completed_date))
    .filter((v): v is string => v !== null)
    .sort()
    .reverse();

  const assetRow =
    ref.assetId !== null
      ? await client.query<{ last_scan_at: Date | null; last_verified_at: Date | null }>(
          `SELECT last_scan_at, last_verified_at FROM asset_register WHERE id = $1`,
          [ref.assetId]
        )
      : null;

  const stats = ticketStats.rows[0];
  const scans = scanStats.rows[0];
  return {
    asset: ref,
    tickets: {
      open: Number(stats?.open ?? 0),
      total: Number(stats?.total ?? 0),
      last30Days: Number(stats?.recent ?? 0),
    },
    inspections: {
      lastScanAt: iso(assetRow?.rows[0]?.last_scan_at) ?? str(scans?.last_scan),
      lastVerifiedAt: iso(assetRow?.rows[0]?.last_verified_at),
      scans: Number(scans?.total ?? 0),
      denials: Number(scans?.denials ?? 0),
    },
    recentTickets: recentTickets.rows,
    recentScans: recentScans.rows,
    maintenance: {
      workOrders: maintenance.totals.workOrders,
      lastCompletedAt: completed[0] ?? null,
    },
  };
}
// ------------------------------------------- scan driven ticket creation

/**
 * The subcategory a scan lands in. Resolved by code rather than by id so the
 * mapping survives a reseed and stays readable in the audit trail.
 */
export interface ScanClassification {
  categoryCode: string;
  subcategoryCode: string;
  categoryId: number;
  subcategoryId: number;
  /** True when the caller named the category and it validated. */
  explicit: boolean;
}

/**
 * Keyword -> subcategory rules, most specific first. The equipment name is the
 * best signal available: the Asset Register category tree is maintained by hand
 * and is not guaranteed to distinguish a printer from a plotter.
 */
const SCAN_SUBCATEGORY_RULES: ReadonlyArray<{ test: RegExp; category: string; subcategory: string }> = [
  { test: /(hikvision|ds-?k1|face\s*recog|fingerprint|time\s*clock|attendance)/i, category: 'ATTENDANCE', subcategory: 'DEVICE_FAILURE' },
  { test: /(cctv|nvr|dvr|surveillance|security\s*camera)/i, category: 'SECURITY', subcategory: 'CCTV' },
  { test: /(access\s*control|turnstile|door\s*controller|electric\s*lock|boom\s*barrier)/i, category: 'SECURITY', subcategory: 'ACCESS_CONTROL' },
  { test: /(router|switch|firewall|access\s*point|wireless|patch\s*panel|uplink|modem|gateway)/i, category: 'NETWORK', subcategory: 'NETWORK_EQUIPMENT' },
  { test: /(printer|plotter|multifunction|\bmfp\b)/i, category: 'IT_SUPPORT', subcategory: 'PRINTER' },
  { test: /(scanner|scan\s*station)/i, category: 'IT_SUPPORT', subcategory: 'SCANNER' },
  { test: /(laptop|notebook|macbook|ultrabook|thinkpad)/i, category: 'IT_SUPPORT', subcategory: 'LAPTOP' },
  { test: /(desktop|workstation|all-?in-?one|\bpc\b|system\s*unit)/i, category: 'IT_SUPPORT', subcategory: 'DESKTOP' },
  { test: /(server|\bups\b|\bnas\b|storage)/i, category: 'IT_SUPPORT', subcategory: 'HARDWARE' },
];

/**
 * How a production machine's runtime state projects onto the Asset Register, so
 * a machine promoted into the register never claims to be healthier than it is.
 */
const MACHINE_ASSET_PROJECTION: Record<string, { status: string; operationalState: string; condition: string }> = {
  OPERATIONAL: { status: 'IN_USE', operationalState: 'OPERATIONAL', condition: 'GOOD' },
  IDLE: { status: 'AVAILABLE', operationalState: 'IDLE', condition: 'GOOD' },
  MAINTENANCE: { status: 'UNDER_MAINTENANCE', operationalState: 'NOT_IN_USE', condition: 'FAIR' },
  BREAKDOWN: { status: 'DAMAGED', operationalState: 'FAULTED', condition: 'DAMAGED' },
  OFFLINE: { status: 'IN_STORE', operationalState: 'NOT_IN_USE', condition: 'GOOD' },
};

const MACHINE_MAINTENANCE_STATES = ['NONE', 'DUE', 'IN_PROGRESS', 'OVERDUE'];

/**
 * Promote a production machine into the Asset Register the first time a
 * technician scans it.
 *
 * The register is the only table a ticket may point at through
 * service_tickets.affected_asset_id, and machines live in their own table. A
 * scan of a machine-only QR therefore has to materialise the register row
 * rather than quietly drop the asset link, otherwise the ticket loses the one
 * fact that makes asset history work later. The row is derived from the machine
 * and back-linked through machines.asset_id so the two never drift.
 */
async function ensureMachineAsset(
  client: pg.PoolClient,
  ctx: Ctx,
  detail: AssetIdentityDetail
): Promise<{ assetId: number; created: boolean }> {
  if (detail.assetId !== null) return { assetId: detail.assetId, created: false };
  if (detail.machineId === null) {
    throw badRequest('The scanned code does not resolve to an asset or a machine');
  }

  const machine = await machineRuntime(client, ctx, detail.machineId);
  if (!machine) throw notFound('Machine not found');

  const machineCode = str(machine.code) ?? detail.assetNo;
  const existing = await client.query<{ id: number }>(
    `SELECT id FROM asset_register
      WHERE tenant_id = $1 AND company_id = $2 AND asset_no = $3`,
    [ctx.tenantId, ctx.companyId, machineCode]
  );
  if (existing.rows.length > 0) {
    const assetId = Number(existing.rows[0].id);
    await linkMachineAsset(client, ctx, detail.machineId, assetId);
    return { assetId, created: false };
  }

  const runtime = String(machine.status ?? 'OPERATIONAL').toUpperCase();
  const state = MACHINE_ASSET_PROJECTION[runtime] ?? MACHINE_ASSET_PROJECTION.OPERATIONAL;
  const rawMaintenance = String(machine.maintenance_status ?? 'NONE').toUpperCase();
  const maintenanceStatus = MACHINE_MAINTENANCE_STATES.includes(rawMaintenance) ? rawMaintenance : 'NONE';
  const machineName = str(machine.name) ?? detail.name;

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO asset_register
       (tenant_id, company_id, branch_id, asset_no, name, is_machine, machine_ref, qr_id,
        department_id, status, condition, operational_state, maintenance_status,
        manufacturer, model, serial_no, is_high_value, created_by, updated_by, attributes)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18::jsonb)
     ON CONFLICT (company_id, asset_no)
     DO UPDATE SET is_deleted = false, updated_at = now()
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.companyId,
      detail.branchId ?? ctx.branchId ?? null,
      machineCode,
      machineName,
      machineCode,
      detail.qrId,
      detail.departmentId,
      state.status,
      state.condition,
      state.operationalState,
      maintenanceStatus,
      str(machine.make),
      str(machine.model),
      str(machine.serial_no),
      bool(machine.is_secure),
      ctx.userId ?? null,
      JSON.stringify({
        source: 'QR_SCAN',
        machineId: detail.machineId,
        machineCode,
        machineType: str(machine.type),
        machineLocation: str(machine.location),
        promotedAt: nowIso(),
      }),
    ]
  );

  const assetId = Number(inserted.rows[0].id);
  await linkMachineAsset(client, ctx, detail.machineId, assetId);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.machine_asset',
    recordId: assetId,
    recordCode: machineCode,
    newValues: {
      asset_no: machineCode,
      name: machineName,
      is_machine: true,
      machine_ref: machineCode,
      status: state.status,
    },
    metadata: {
      machineId: detail.machineId,
      reason: 'Production machine promoted into the Asset Register by a QR scan',
    },
  });
  return { assetId, created: true };
}

/** Point the machine at its register row. Idempotent by predicate. */
async function linkMachineAsset(
  client: pg.PoolClient,
  ctx: Ctx,
  machineId: number,
  assetId: number
): Promise<void> {
  await client.query(
    `UPDATE machines SET asset_id = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND (asset_id IS NULL OR asset_id <> $1)`,
    [assetId, machineId, ctx.tenantId]
  );
}

/**
 * Pick the category and subcategory a scan raises its ticket under.
 *
 * An explicit choice from the client always wins, but only after it validates
 * against the active taxonomy: a technician must never be able to file a
 * production outage under FACILITIES by pasting an arbitrary subcategory id.
 */
export async function classifyScanTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  detail: AssetIdentityDetail,
  action: AssetScanAction,
  b: Record<string, unknown> = {}
): Promise<ScanClassification> {
  const explicitCategoryId = nn(b.categoryId ?? b.category_id);
  const explicitSubcategoryId = nn(b.subcategoryId ?? b.subcategory_id);

  if (explicitCategoryId !== null || explicitSubcategoryId !== null) {
    if (explicitCategoryId === null || explicitSubcategoryId === null) {
      throw badRequest('A category and a subcategory must be supplied together');
    }
    const row = await client.query<{ category_code: string; subcategory_code: string }>(
      `SELECT c.code AS category_code, s.code AS subcategory_code
         FROM service_subcategories s
         JOIN service_categories c ON c.id = s.category_id
        WHERE s.id = $1 AND s.category_id = $2
          AND s.tenant_id = $3 AND s.company_id = $4
          AND s.is_active AND c.is_active`,
      [explicitSubcategoryId, explicitCategoryId, ctx.tenantId, ctx.companyId]
    );
    if (row.rows.length === 0) {
      throw badRequest('The selected category and subcategory are not an active pairing');
    }
    return {
      categoryCode: String(row.rows[0].category_code),
      subcategoryCode: String(row.rows[0].subcategory_code),
      categoryId: explicitCategoryId,
      subcategoryId: explicitSubcategoryId,
      explicit: true,
    };
  }

  const haystack = [detail.name, detail.categoryName, detail.assetNo, detail.manufacturer, detail.model]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');

  let category = 'IT_SUPPORT';
  let subcategory = 'HARDWARE';

  if (action === 'REQUEST_MAINTENANCE') {
    category = 'MAINTENANCE';
    subcategory = detail.isMachine ? 'MACHINE_MAINTENANCE' : 'FACILITY_MAINTENANCE';
  } else if (detail.isMachine || detail.entityType === 'MACHINE') {
    category = 'PRODUCTION';
    const machineCode = detail.assetNo.toUpperCase();
    if (machineCode.startsWith('FSS104')) subcategory = 'FSS104';
    else if (machineCode.startsWith('FSS300')) subcategory = 'FSS300';
    else subcategory = 'PRODUCTION_MACHINE';
  } else {
    const rule = SCAN_SUBCATEGORY_RULES.find((r) => r.test.test(haystack));
    if (rule) {
      category = rule.category;
      subcategory = rule.subcategory;
    } else if (detail.isSecure) {
      category = 'SECURITY';
      subcategory = 'SECURITY_EQUIPMENT';
    }
  }

  const resolved = await client.query<{ id: number; category_id: number }>(
    `SELECT s.id, s.category_id
       FROM service_subcategories s
       JOIN service_categories c ON c.id = s.category_id
      WHERE s.code = $1 AND c.code = $2
        AND s.tenant_id = $3 AND s.company_id = $4
        AND s.is_active AND c.is_active`,
    [subcategory, category, ctx.tenantId, ctx.companyId]
  );
  const row = resolved.rows[0];
  if (row) {
    return {
      categoryCode: category,
      subcategoryCode: subcategory,
      categoryId: Number(row.category_id),
      subcategoryId: Number(row.id),
      explicit: false,
    };
  }

  // The taxonomy is administrator editable, so a company may have renamed or
  // retired the default pair. Falling back keeps a scan usable instead of
  // failing with a dead end.
  const fallback = await client.query<{ id: number; category_id: number }>(
    `SELECT s.id, s.category_id
       FROM service_subcategories s
       JOIN service_categories c ON c.id = s.category_id
      WHERE s.code = 'HARDWARE' AND c.code = 'IT_SUPPORT'
        AND s.tenant_id = $1 AND s.company_id = $2
        AND s.is_active AND c.is_active`,
    [ctx.tenantId, ctx.companyId]
  );
  const backup = fallback.rows[0];
  if (!backup) throw badRequest('No active service category is configured for QR raised tickets');
  return {
    categoryCode: 'IT_SUPPORT',
    subcategoryCode: 'HARDWARE',
    categoryId: Number(backup.category_id),
    subcategoryId: Number(backup.id),
    explicit: false,
  };
}


// ------------------------------------------------- scan driven ticket raising

/** Ticket types a scan may raise. Anything else is a workflow of its own. */
export const SCAN_RAISABLE_TICKET_TYPES = [
  'INCIDENT',
  'SERVICE_REQUEST',
  'MAINTENANCE_REQUEST',
  'SECURITY_INCIDENT',
] as const;

const SCAN_ACTION_LABEL: Record<AssetScanAction, string> = {
  VIEW: 'Asset scan of',
  REPORT_INCIDENT: 'Incident reported at',
  CREATE_SERVICE_REQUEST: 'Service request for',
  VIEW_ASSET_HISTORY: 'Asset history for',
  VIEW_MAINTENANCE_HISTORY: 'Maintenance history for',
  UPDATE_TICKET: 'Asset update for',
  REQUEST_MAINTENANCE: 'Maintenance request for',
};

function scanSubject(action: AssetScanAction, detail: AssetIdentityDetail): string {
  const title = SCAN_ACTION_LABEL[action] + ' ' + detail.name;
  return title.length <= 200 ? title : title.slice(0, 197) + '...';
}

function scanDescription(
  action: AssetScanAction,
  detail: AssetIdentityDetail,
  actor: string | null
): string {
  const lines = [
    'Raised automatically from a QR asset scan' + (actor ? ' by ' + actor : '') + '.',
    'Asset: ' + detail.name + ' (' + detail.assetNo + ')',
    'Register status: ' + (detail.status ?? 'UNKNOWN'),
    detail.locationName ? 'Location: ' + detail.locationName : null,
    detail.condition ? 'Condition: ' + detail.condition : null,
    detail.maintenanceStatus ? 'Maintenance: ' + detail.maintenanceStatus : null,
    detail.qrValue ? 'QR: ' + detail.qrValue : null,
    action === 'REQUEST_MAINTENANCE'
      ? 'The scanning technician requested maintenance for this equipment.'
      : null,
  ];
  return lines.filter((v): v is string => v !== null).join('\n');
}

function scanTags(detail: AssetIdentityDetail, action: AssetScanAction): string[] {
  const tags = ['qr-scan', 'asset-service-desk', detail.entityType.toLowerCase()];
  if (detail.isSecure) tags.push('secure-asset');
  if (action === 'REQUEST_MAINTENANCE') tags.push('maintenance');
  return tags;
}

export interface AssetScanTicketResult {
  scanId: number;
  ticketId: number;
  ticketNumber: string;
  ticketType: string;
  status: string;
  priority: string;
  subject: string;
  classification: ScanClassification;
  asset: {
    assetId: number;
    assetNo: string;
    name: string;
    machineId: number | null;
    entityType: AssetEntityType;
    promoted: boolean;
  };
  assignment: Record<string, unknown> | null;
  sla: Record<string, unknown> | null;
}

/**
 * Turn a cleared scan into a real ticket.
 *
 * The scan has already passed RBAC and the organizational scope check. What
 * happens here is the part that touches the ticket aggregate, so it goes through
 * createTicket rather than writing service_tickets directly: numbering, the SLA
 * window, the queue, the assignment engine, the audit row and the desk
 * notification all stay in one place.
 */
export async function raiseTicketFromScan(
  client: pg.PoolClient,
  ctx: Ctx,
  prep: AssetScanPreparation,
  b: Record<string, unknown> = {}
): Promise<AssetScanTicketResult> {
  const detail = prep.detail;
  if (!detail) throw badRequest('The scanned code did not resolve to an asset');
  if (!prep.allowed) throw forbidden(prep.denyReason ?? 'This scan was refused');

  const action = prep.action;
  const defaultType = ASSET_SCAN_TICKET_TYPE[action];
  if (!defaultType) {
    throw badRequest('A scan with the action ' + action + ' does not raise a ticket');
  }

  const requestedType = oneOf(b.ticketType ?? b.ticket_type, SCAN_RAISABLE_TICKET_TYPES);
  if ((b.ticketType ?? b.ticket_type) !== undefined && !requestedType) {
    throw badRequest('ticketType must be one of ' + SCAN_RAISABLE_TICKET_TYPES.join(', '));
  }
  const ticketType = requestedType ?? defaultType;

  const classification = await classifyScanTicket(client, ctx, detail, action, b);
  const ensured = await ensureMachineAsset(client, ctx, detail);

  // A scan may name a different requester only when the caller may act on
  // behalf of somebody else; otherwise the impersonation hole would simply
  // reopen through the QR door. prep.scope is the scope the scan was
  // authorized against, so no second lookup is needed.
  const claimedEmployeeId = nn(b.requesterEmployeeId ?? b.requester_employee_id);
  const claimedUserId = nn(b.requesterUserId ?? b.requester_user_id);
  const onBehalf = mayActOnBehalf(prep.scope);
  const foreignRequester =
    (claimedEmployeeId !== null && claimedEmployeeId !== prep.scope.employeeId) ||
    (claimedUserId !== null && claimedUserId !== prep.scope.userId);
  if (foreignRequester && !onBehalf) {
    throw forbidden(
      'Raising a ticket for another employee requires ' + CREATE_ON_BEHALF_PERMISSION
    );
  }
  const requesterEmployeeId = onBehalf ? claimedEmployeeId : null;
  const requesterUserId = onBehalf ? claimedUserId : null;
  const namedRequester =
    onBehalf && (claimedEmployeeId !== null || claimedUserId !== null);
  const actor = await displayName(client, ctx.userId ?? null);

  const deviceInfo: Record<string, unknown> = {
    source: 'QR_SCAN',
    scanId: prep.scanId,
    scanAction: action,
    entityType: detail.entityType,
    assetId: ensured.assetId,
    assetNo: detail.assetNo,
    machineId: detail.machineId,
    machineCode: detail.entityType === 'MACHINE' ? detail.assetNo : null,
    qrId: detail.qrId,
    qrValue: detail.qrValue,
    scannedByUserId: ctx.userId ?? null,
    scannedAt: nowIso(),
  };

  const created = await createTicket(
    client,
    ctx,
    {
      ticketType,
      categoryId: classification.categoryId,
      subcategoryId: classification.subcategoryId,
      subject: s(b.subject) ?? scanSubject(action, detail),
      description: s(b.description) ?? s(b.note) ?? scanDescription(action, detail, actor),
      impact: b.impact,
      urgency: b.urgency,
      priority: b.priority,
      priorityOverrideReason: b.priorityOverrideReason ?? b.priority_override_reason,
      preferredContact: b.preferredContact ?? b.preferred_contact ?? b.contact,
      affectedAssetId: ensured.assetId,
      tags: b.tags ?? scanTags(detail, action),
      deviceInfo,
      source: 'QR_SCAN',
      branchId: detail.branchId ?? undefined,
      departmentId: detail.departmentId ?? undefined,
      requesterEmployeeId: namedRequester ? requesterEmployeeId : undefined,
      requesterUserId: namedRequester ? requesterUserId : undefined,
    },
    { selfService: !namedRequester }
  );

  const ticket = created as unknown as Record<string, unknown>;
  const ticketId = Number(ticket.id);
  const ticketNumber = String(ticket.ticket_number);
  const priority = String(ticket.priority);
  const status = String(ticket.status);

  await attachScanTicket(client, ctx, prep.scanId, ticketId);

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.asset_ticket',
    recordId: ticketId,
    recordCode: ticketNumber,
    newValues: {
      ticket_number: ticketNumber,
      ticket_type: ticketType,
      category: classification.categoryCode,
      subcategory: classification.subcategoryCode,
      affected_asset_id: ensured.assetId,
      asset_no: detail.assetNo,
      machine_id: detail.machineId,
      scan_id: prep.scanId,
      scan_action: action,
      priority,
    },
    metadata: {
      source: 'QR_SCAN',
      scannedCode: prep.code,
      classificationExplicit: classification.explicit,
      assetPromoted: ensured.created,
    },
  });

  await emitEvent(client, ctx, {
    eventType: 'service_desk.asset_ticket_raised',
    entityType: 'service_tickets',
    entityId: ticketId,
    entityCode: ticketNumber,
    payload: {
      scanId: prep.scanId,
      scanAction: action,
      assetId: ensured.assetId,
      assetNo: detail.assetNo,
      ticketType,
      priority,
    },
    severity: priority === 'P1' ? 'CRITICAL' : priority === 'P2' ? 'WARN' : 'INFO',
  });

  // createTicket already tells the desk. The requester only needs telling when
  // somebody else raised the ticket for them; a self-service scan needs no
  // notification at all because the person is looking at the screen.
  const raisedForUserId = n(ticket.requester_user_id);
  if (namedRequester && raisedForUserId !== null) {
    await notifyUsers(client, ctx, [raisedForUserId], {
      type: 'service_desk.ticket_created',
      title: 'Ticket ' + ticketNumber + ' was raised for you',
      body: scanSubject(action, detail),
      link: '/service-desk/tickets/' + String(ticketId),
      entityType: 'service_tickets',
      entityId: ticketId,
      severity: 'INFO',
    });
  }

  return {
    scanId: prep.scanId,
    ticketId,
    ticketNumber,
    ticketType,
    status,
    priority,
    subject: String(ticket.subject),
    classification,
    asset: {
      assetId: ensured.assetId,
      assetNo: detail.assetNo,
      name: detail.name,
      machineId: detail.machineId,
      entityType: detail.entityType,
      promoted: ensured.created,
    },
    assignment: (ticket.assignment as Record<string, unknown> | undefined) ?? null,
    sla: (ticket.sla as Record<string, unknown> | undefined) ?? null,
  };
}

// ------------------------------------------------ asset maintenance requests

/** asset_maintenance_work_orders CHECK vocabulary, re-published for validation. */
export const ASSET_MAINTENANCE_TYPES = [
  'PREVENTIVE',
  'CORRECTIVE',
  'EMERGENCY',
  'INSPECTION',
  'CALIBRATION',
  'SERVICE',
  'REPAIR',
] as const;

export const ASSET_MAINTENANCE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const MAINTENANCE_TYPE_FOR_ACTION: Record<string, string> = {
  REPORT_INCIDENT: 'CORRECTIVE',
  REQUEST_MAINTENANCE: 'CORRECTIVE',
};

const MAINTENANCE_PRIORITY_FOR_TICKET: Record<string, string> = {
  P1: 'URGENT',
  P2: 'HIGH',
  P3: 'MEDIUM',
  P4: 'LOW',
};

/** Permission that authorises writing to the Asset Register maintenance ledger. */
const MAINTENANCE_WRITE_PERMISSION = 'assets.maintenance.create';

export interface AssetMaintenanceRequestResult {
  scanId: number;
  assetId: number;
  assetNo: string;
  ticket: AssetScanTicketResult;
  workOrderId: number | null;
  woNo: string | null;
  maintenanceType: string;
  priority: string;
  status: string | null;
  scheduledDate: string | null;
  /** True when the ticket carries the request but the caller may not open a work order. */
  workOrderDeferred: boolean;
  deferredReason: string | null;
}

/**
 * A technician scanning a machine and asking for maintenance.
 *
 * The ticket is always raised: it is the record that the request happened and
 * the object the SLA clock runs against. The work order is a second, separately
 * authorised artefact, because writing to the maintenance ledger is a
 * Maintenance module privilege. When the caller does not hold it the request is
 * still captured and routed to the people who do, rather than being refused at
 * the point of care.
 */
export async function requestAssetMaintenance(
  client: pg.PoolClient,
  ctx: Ctx,
  prep: AssetScanPreparation,
  b: Record<string, unknown> = {}
): Promise<AssetMaintenanceRequestResult> {
  const detail = prep.detail;
  if (!detail) throw badRequest('The scanned code did not resolve to an asset');
  if (prep.scope.isAdmin === false && !hasPerm(prep.scope.permissions, 'service_desk.tickets.create')) {
    throw forbidden('Missing permission: service_desk.tickets.create');
  }

  const requestedType = oneOf(b.maintenanceType ?? b.maintenance_type, ASSET_MAINTENANCE_TYPES);
  if ((b.maintenanceType ?? b.maintenance_type) !== undefined && !requestedType) {
    throw badRequest('maintenanceType must be one of ' + ASSET_MAINTENANCE_TYPES.join(', '));
  }
  const requestedPriority = oneOf(b.workOrderPriority ?? b.work_order_priority, ASSET_MAINTENANCE_PRIORITIES);
  if ((b.workOrderPriority ?? b.work_order_priority) !== undefined && !requestedPriority) {
    throw badRequest('workOrderPriority must be one of ' + ASSET_MAINTENANCE_PRIORITIES.join(', '));
  }

  const ticket = await raiseTicketFromScan(client, ctx, prep, {
    ...b,
    ticketType: b.ticketType ?? 'MAINTENANCE_REQUEST',
    description: s(b.description) ?? s(b.note) ?? undefined,
  });

  const ensured = await ensureMachineAsset(client, ctx, detail);
  const maintenanceType = requestedType ?? MAINTENANCE_TYPE_FOR_ACTION[prep.action] ?? 'CORRECTIVE';
  const priority =
    requestedPriority ??
    MAINTENANCE_PRIORITY_FOR_TICKET[ticket.priority] ??
    'MEDIUM';

  const base = {
    scanId: prep.scanId,
    assetId: ensured.assetId,
    assetNo: detail.assetNo,
    ticket,
    maintenanceType,
    priority,
    scheduledDate: s(b.scheduledDate ?? b.scheduled_date) ?? null,
  };

  const mayWrite = prep.scope.isAdmin || hasPerm(prep.scope.permissions, MAINTENANCE_WRITE_PERMISSION);
  if (!mayWrite) {
    await logAudit(client, ctx, {
      action: 'defer',
      resource: 'service_desk.asset_maintenance',
      recordId: ticket.ticketId,
      recordCode: ticket.ticketNumber,
      metadata: {
        assetId: ensured.assetId,
        assetNo: detail.assetNo,
        requiredPermission: MAINTENANCE_WRITE_PERMISSION,
        reason: 'Scan actor may not write to the maintenance ledger; request routed to maintenance',
      },
    });
    const maintenanceOwners = await usersWithPermission(client, ctx, MAINTENANCE_WRITE_PERMISSION);
    await notifyUsers(client, ctx, maintenanceOwners, {
      type: 'service_desk.asset_maintenance_requested',
      title: 'Maintenance requested for ' + detail.name,
      body: 'Ticket ' + ticket.ticketNumber + ' requests ' + maintenanceType + ' maintenance on ' + detail.assetNo,
      link: '/assets/maintenance',
      entityType: 'service_tickets',
      entityId: ticket.ticketId,
      severity: priority === 'URGENT' || priority === 'HIGH' ? 'WARN' : 'INFO',
    });
    return {
      ...base,
      workOrderId: null,
      woNo: null,
      status: null,
      workOrderDeferred: true,
      deferredReason: 'Requires the ' + MAINTENANCE_WRITE_PERMISSION + ' permission',
    };
  }

  const woRes = await client.query<{ code: string }>(
    `SELECT next_doc_no($1,$2,8) AS code`,
    [ctx.tenantId, 'WO']
  );
  const woNo = String(woRes.rows[0].code);

  const description =
    'Asset QR scan ' + prep.code + '. Raised from ticket ' + ticket.ticketNumber + '.' +
    (s(b.note) ? ' Technician note: ' + s(b.note) : '') +
    (s(b.description) ? ' ' + s(b.description) : '');

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO asset_maintenance_work_orders
       (company_id, tenant_id, branch_id, asset_id, wo_no, maintenance_type, priority, status,
        technician_user_id, supplier_id, scheduled_date, cost, downtime_hours, description,
        created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SUBMITTED',$8,$9,$10,$11,$12,$13,$14,$14)
     RETURNING id`,
    [
      ctx.companyId,
      ctx.tenantId,
      detail.branchId ?? ctx.branchId ?? null,
      ensured.assetId,
      woNo,
      maintenanceType,
      priority,
      nn(b.technicianUserId ?? b.technician_user_id),
      nn(b.supplierId ?? b.supplier_id),
      s(b.scheduledDate ?? b.scheduled_date),
      Number(n(b.cost) ?? 0),
      Number(n(b.downtimeHours ?? b.downtime_hours) ?? 0),
      description,
      ctx.userId ?? null,
    ]
  );
  const workOrderId = Number(inserted.rows[0].id);

  // The scan row already exists and carries the intent. The work order is
  // recorded on the audit trail and announced on the event stream instead, so a
  // single scan never produces two scan rows.
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.asset_maintenance',
    recordId: workOrderId,
    recordCode: woNo,
    newValues: {
      asset_id: ensured.assetId,
      asset_no: detail.assetNo,
      maintenance_type: maintenanceType,
      priority,
      status: 'SUBMITTED',
      ticket_id: ticket.ticketId,
      ticket_number: ticket.ticketNumber,
      scan_id: prep.scanId,
    },
    metadata: { source: 'QR_SCAN', code: prep.code },
  });

  await emitEvent(client, ctx, {
    eventType: 'service_desk.asset_maintenance_raised',
    entityType: 'asset_maintenance_work_orders',
    entityId: workOrderId,
    entityCode: woNo,
    payload: {
      assetId: ensured.assetId,
      assetNo: detail.assetNo,
      maintenanceType,
      priority,
      ticketId: ticket.ticketId,
    },
    severity: priority === 'URGENT' ? 'CRITICAL' : 'INFO',
  });

  return {
    ...base,
    workOrderId,
    woNo,
    status: 'SUBMITTED',
    workOrderDeferred: false,
    deferredReason: null,
  };
}

// Comment types a scan may post. Declared before the dispatcher that uses it.
const COMMENT_TYPES_ALLOWED = ['REPLY', 'NOTE'] as const;

// -------------------------------------------------- scan action dispatcher

export interface AssetScanExecution {
  scanId: number;
  action: AssetScanAction;
  /** Field-level authorized projection. Never the raw identity detail. */
  asset: Record<string, unknown> | null;
  history: AssetServiceHistory | null;
  maintenance: AssetMaintenanceHistory | null;
  ticket: AssetScanTicketResult | null;
  workOrder: AssetMaintenanceRequestResult | null;
  ticketId: number | null;
  ticketNumber: string | null;
  commentId: number | null;
}

/**
 * Run the work the scan asked for. The caller must have already re-checked the
 * ABAC decision with the published attributes, because authorization is not
 * something a service function should be able to skip by being called directly.
 */
export async function executeAssetScan(
  client: pg.PoolClient,
  ctx: Ctx,
  prep: AssetScanPreparation,
  b: Record<string, unknown> = {}
): Promise<AssetScanExecution> {
  const detail = prep.detail;
  if (!detail) throw badRequest('The scanned code did not resolve to an asset');
  if (!prep.allowed) throw forbidden(prep.denyReason ?? 'This scan was refused');

  const base = {
    scanId: prep.scanId,
    action: prep.action,
    asset: prep.asset,
    history: null as AssetServiceHistory | null,
    maintenance: null as AssetMaintenanceHistory | null,
    ticket: null as AssetScanTicketResult | null,
    workOrder: null as AssetMaintenanceRequestResult | null,
    ticketId: null as number | null,
    ticketNumber: null as string | null,
    commentId: null as number | null,
  };

  const assetRef = async (): Promise<AssetRef> =>
    resolveAssetRef(client, ctx, detail.assetId ?? detail.machineId ?? detail.assetNo);

  switch (prep.action) {
    case 'VIEW':
      return base;

    case 'VIEW_ASSET_HISTORY': {
      const history = await assetServiceHistory(client, ctx, await assetRef());
      return { ...base, history };
    }

    case 'VIEW_MAINTENANCE_HISTORY': {
      const maintenance = await assetMaintenanceHistory(client, ctx, await assetRef());
      return { ...base, maintenance };
    }

    case 'REPORT_INCIDENT':
    case 'CREATE_SERVICE_REQUEST': {
      const ticket = await raiseTicketFromScan(client, ctx, prep, b);
      return { ...base, ticket, ticketId: ticket.ticketId, ticketNumber: ticket.ticketNumber };
    }

    case 'REQUEST_MAINTENANCE': {
      const workOrder = await requestAssetMaintenance(client, ctx, prep, b);
      return {
        ...base,
        workOrder,
        ticket: workOrder.ticket,
        ticketId: workOrder.ticket.ticketId,
        ticketNumber: workOrder.ticket.ticketNumber,
      };
    }

    case 'UPDATE_TICKET': {
      const requestedId = nn(b.ticketId ?? b.ticket_id);
      const requestedNumber = s(b.ticketNumber ?? b.ticket_number);
      const ticket = requestedId !== null
        ? await loadTicketRow(client, ctx, requestedId)
        : requestedNumber
          ? await loadTicketByNumber(client, ctx, requestedNumber)
          : null;
      if (!ticket) throw badRequest('A ticketId or ticketNumber is required to update a ticket from a scan');

      const target = Number(ticket.id);
      const linkedAssetId = n(ticket.affected_asset_id) ?? null;
      const rawDevice = ((ticket as unknown as Record<string, unknown>).device_info ?? {}) as Record<string, unknown>;
      const linkedMachineId = str(rawDevice.machineId);
      const sameAsset = detail.assetId !== null && linkedAssetId === detail.assetId;
      const sameMachine =
        detail.machineId !== null && linkedMachineId !== null && linkedMachineId === String(detail.machineId);

      // A scan may amend any ticket when the caller works the desk, but an
      // ordinary employee may only attach evidence to a ticket about their own
      // equipment. Without this a scan would be a way to write into any ticket.
      if (!sameAsset && !sameMachine && !prep.scope.isAgent && !prep.scope.isAdmin) {
        throw forbidden('Ticket ' + String(ticket.ticket_number) + ' is not about the scanned asset');
      }

      await attachScanTicket(client, ctx, prep.scanId, target);

      let commentId: number | null = null;
      const note = s(b.note ?? b.body ?? b.message);
      if (note) {
        const declared = oneOf(b.commentType ?? b.comment_type, COMMENT_TYPES_ALLOWED);
        const requested =
          declared ?? (truthy(b.internal) || prep.scope.canViewInternalNotes ? 'NOTE' : 'REPLY');
        if (requested === 'NOTE' && !prep.scope.canViewInternalNotes) {
          throw forbidden('You are not authorised to add internal notes');
        }
        const comment = (await addComment(client, ctx, target, {
          body: note,
          commentType: requested,
        })) as Record<string, unknown>;
        commentId = n(comment.id) ?? null;
      }

      await logAudit(client, ctx, {
        action: 'update',
        resource: 'service_desk.asset_ticket',
        recordId: target,
        recordCode: str(ticket.ticket_number),
        newValues: {
          scan_id: prep.scanId,
          scan_action: prep.action,
          asset_id: detail.assetId,
          machine_id: detail.machineId,
          asset_no: detail.assetNo,
          comment_id: commentId,
        },
        metadata: { source: 'QR_SCAN', code: prep.code, matchedBy: sameAsset ? 'ASSET' : sameMachine ? 'MACHINE' : 'DESK_SCOPE' },
      });

      await emitEvent(client, ctx, {
        eventType: 'service_desk.asset_scan_linked',
        entityType: 'service_tickets',
        entityId: target,
        entityCode: str(ticket.ticket_number),
        payload: { scanId: prep.scanId, assetId: detail.assetId, machineId: detail.machineId, commentId },
        severity: 'INFO',
      });

      return { ...base, ticketId: target, ticketNumber: str(ticket.ticket_number), commentId };
    }

    default:
      throw badRequest('Unsupported scan action: ' + String(prep.action));
  }
}



