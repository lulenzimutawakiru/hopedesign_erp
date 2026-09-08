/**
 * Hikvision integration operations API (RBAC + ABAC).
 *
 * Every route requires an explicit permission (requirePermission) which also
 * evaluates SoD + ABAC policies and company scope before the service runs.
 * Services resolve the caller's organizational scope internally (resolveOrg)
 * so branch/company restricted users can never read or mutate outside their
 * scope (defence in depth: route RBAC + service ABAC).
 *
 * Mapped surfaces:
 *   /api/hikvision/devices|dashboard|health|events|exceptions|links|sync
 *   /api/attendance (records, periods, adjustments, approvals)
 */
import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as adminDevices from '../../services/hikvision/adminDevices.js';
import * as adminEvents from '../../services/hikvision/adminEvents.js';
import * as adminExceptions from '../../services/hikvision/adminExceptions.js';
import * as adminAttendance from '../../services/hikvision/adminAttendance.js';
import * as adminSync from '../../services/hikvision/adminSync.js';

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// ============================================================================
// Attendance records / periods / adjustments (shared registration so the same
// handlers can be exposed under both /api/hikvision/attendance and the public
// /api/attendance surface required by the integration contract).
// ============================================================================
function registerAttendanceRoutes(r: Router): void {
  // GET /                     -> listAttendance
  r.get('/', ...runGet('hr.attendance.view', (c, ctx, q) => adminAttendance.listAttendance(c, ctx, q)));
  // GET /periods              -> listAttendancePeriods
  r.get('/periods', ...runGet('hr.attendance.view', (c, ctx, q) => adminAttendance.listAttendancePeriods(c, ctx, q)));
  // POST /periods             -> createAttendancePeriod
  r.post('/periods', ...run('hr.attendance.lock', (c, ctx, b) => adminAttendance.createAttendancePeriod(c, ctx, b)));
  // POST /periods/:id/submit  -> submitAttendancePeriod
  r.post('/periods/:id/submit', ...run('hr.attendance.review', (c, ctx, _b, p) => adminAttendance.submitAttendancePeriod(c, ctx, Number(p.id))));
  // POST /periods/:id/approve -> approveAttendancePeriod
  r.post('/periods/:id/approve', ...run('hr.attendance.approve', (c, ctx, b, p) => adminAttendance.approveAttendancePeriod(c, ctx, Number(p.id), b)));
  // POST /periods/:id/lock    -> lockAttendancePeriod
  r.post('/periods/:id/lock', ...run('hr.attendance.lock', (c, ctx, b, p) => adminAttendance.lockAttendancePeriod(c, ctx, Number(p.id), b)));
  // POST /periods/:id/reopen  -> reopenAttendancePeriod
  r.post('/periods/:id/reopen', ...run('hr.attendance.lock', (c, ctx, b, p) => adminAttendance.reopenAttendancePeriod(c, ctx, Number(p.id), b)));
  // GET /adjustments          -> listAttendanceAdjustments
  r.get('/adjustments', ...runGet('hr.attendance.view', (c, ctx, q) => adminAttendance.listAttendanceAdjustments(c, ctx, q)));
  // POST /adjustments         -> createAttendanceAdjustment
  r.post('/adjustments', ...run('hr.attendance.create_adjustment', (c, ctx, b) => adminAttendance.createAttendanceAdjustment(c, ctx, b)));
  // POST /adjustments/:id/approve
  r.post('/adjustments/:id/approve', ...run('hr.attendance.approve', (c, ctx, _b, p) => adminAttendance.approveAttendanceAdjustment(c, ctx, Number(p.id))));
  // POST /adjustments/:id/reject
  r.post('/adjustments/:id/reject', ...run('hr.attendance.reject', (c, ctx, b, p) => adminAttendance.rejectAttendanceAdjustment(c, ctx, Number(p.id), b)));
  // GET /employee/:employeeId -> employeeAttendance
  r.get('/employee/:employeeId', ...runGet('hr.attendance.view', (c, ctx, q, p) => adminAttendance.employeeAttendance(c, ctx, Number(p.employeeId), q)));
  // GET /:id                  -> getAttendanceDetail
  r.get('/:id', ...runGet('hr.attendance.view', (c, ctx, _q, p) => adminAttendance.getAttendanceDetail(c, ctx, Number(p.id))));
}

// ============================================================================
// Hikvision integration operations (/api/hikvision)
// ============================================================================
export const hikvisionOpsRouter = Router();

// ---- Command centre / dashboard ----
hikvisionOpsRouter.get('/command', ...runGet('hikvision.command.view', (c, ctx, q) => adminDevices.dashboardSummary(c, ctx, q)));
hikvisionOpsRouter.get('/dashboard', ...runGet('hikvision.dashboard.view', (c, ctx, q) => adminDevices.dashboardSummary(c, ctx, q)));
hikvisionOpsRouter.get('/health', ...runGet('hikvision.health.view', (c, ctx, q) => adminDevices.deviceHealthBoard(c, ctx, q)));

// ---- Devices ----
hikvisionOpsRouter.get('/devices', ...runGet('hikvision.devices.view', (c, ctx, q) => adminDevices.listDevices(c, ctx, q)));
hikvisionOpsRouter.post('/devices', ...run('hikvision.devices.create', (c, ctx, b) => adminDevices.createDevice(c, ctx, b)));
hikvisionOpsRouter.get('/devices/:id', ...runGet('hikvision.devices.view', (c, ctx, _q, p) => adminDevices.getDeviceDetail(c, ctx, Number(p.id))));
hikvisionOpsRouter.patch('/devices/:id', ...run('hikvision.devices.update', (c, ctx, b, p) => adminDevices.updateDevice(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/devices/:id/status', ...run('hikvision.devices.update', (c, ctx, b, p) => adminDevices.setDeviceStatus(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/devices/:id/rotate-key', ...run('hikvision.devices.update', (c, ctx, _b, p) => adminDevices.rotateDeviceKey(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/devices/:id/time-sync', ...run('hikvision.configuration.manage', (c, ctx, b, p) => adminDevices.recordDeviceTimeSync(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.delete('/devices/:id', ...run('hikvision.devices.delete', (c, ctx, b, p) => adminDevices.deleteDevice(c, ctx, Number(p.id), b)));

// ---- Raw / normalized events ----
hikvisionOpsRouter.get('/events', ...runGet('hikvision.events.view', (c, ctx, q) => adminEvents.listRawEvents(c, ctx, q)));
hikvisionOpsRouter.get('/events/failed', ...runGet('hikvision.events.view', (c, ctx, q) => adminEvents.listFailedEvents(c, ctx, q)));
hikvisionOpsRouter.get('/events/:id', ...runGet('hikvision.events.view', (c, ctx, _q, p) => adminEvents.getRawEventDetail(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/events/:id/retry', ...run('hikvision.events.retry', (c, ctx, _b, p) => adminEvents.retryRawEvent(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/events/:id/reprocess', ...run('hikvision.events.reprocess', (c, ctx, _b, p) => adminEvents.reprocessRawEvent(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/events/:id/reject', ...run('hikvision.events.reject', (c, ctx, b, p) => adminEvents.rejectRawEvent(c, ctx, Number(p.id), b)));

// ---- Attendance exceptions ----
hikvisionOpsRouter.get('/exceptions', ...runGet('hikvision.exceptions.view', (c, ctx, q) => adminExceptions.listExceptions(c, ctx, q)));
hikvisionOpsRouter.get('/exceptions/employee-search', ...runGet('hikvision.exceptions.view', (c, ctx, q) => adminExceptions.searchEmployeesForMapping(c, ctx, q)));
hikvisionOpsRouter.get('/exceptions/:id', ...runGet('hikvision.exceptions.view', (c, ctx, _q, p) => adminExceptions.getException(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/exceptions/:id/assign', ...run('hikvision.exceptions.assign', (c, ctx, b, p) => adminExceptions.assignException(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/exceptions/:id/resolve', ...run('hikvision.exceptions.resolve', (c, ctx, b, p) => adminExceptions.resolveException(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/exceptions/:id/approve', ...run('hikvision.exceptions.approve', (c, ctx, b, p) => adminExceptions.approveException(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/exceptions/:id/reject', ...run('hikvision.exceptions.reject', (c, ctx, b, p) => adminExceptions.rejectException(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.post('/exceptions/:id/reopen', ...run('hikvision.exceptions.resolve', (c, ctx, _b, p) => adminExceptions.reopenException(c, ctx, Number(p.id))));
hikvisionOpsRouter.post('/exceptions/:id/map-employee', ...run('hikvision.exceptions.resolve', (c, ctx, b, p) => adminExceptions.mapUnknownEmployee(c, ctx, Number(p.id), b)));

// ---- Employee<->device links ----
hikvisionOpsRouter.get('/links', ...runGet('hikvision.employee_links.view', (c, ctx, q) => adminSync.listEmployeeLinks(c, ctx, q)));
hikvisionOpsRouter.post('/links', ...run('hikvision.employee_links.create', (c, ctx, b) => adminSync.createEmployeeLink(c, ctx, b)));
hikvisionOpsRouter.get('/links/:id', ...runGet('hikvision.employee_links.view', (c, ctx, _q, p) => adminSync.getEmployeeLink(c, ctx, Number(p.id))));
hikvisionOpsRouter.patch('/links/:id', ...run('hikvision.employee_links.update', (c, ctx, b, p) => adminSync.updateEmployeeLink(c, ctx, Number(p.id), b)));
hikvisionOpsRouter.delete('/links/:id', ...run('hikvision.employee_links.delete', (c, ctx, b, p) => adminSync.deleteEmployeeLink(c, ctx, Number(p.id), b)));

// ---- Employee synchronization (ERP -> terminal provisioning) ----
hikvisionOpsRouter.get('/sync/logs', ...runGet('hikvision.sync.view', (c, ctx, q) => adminSync.listSyncLogs(c, ctx, q)));
hikvisionOpsRouter.post('/sync/employee', ...run('hikvision.sync.employee', (c, ctx, b) => adminSync.syncEmployeeToDevice(c, ctx, b)));
hikvisionOpsRouter.post('/sync/selected', ...run('hikvision.sync.bulk', (c, ctx, b) => adminSync.syncSelectedEmployees(c, ctx, b)));
hikvisionOpsRouter.post('/sync/bulk', ...run('hikvision.sync.bulk', (c, ctx, b) => adminSync.syncBulkEmployees(c, ctx, b)));
hikvisionOpsRouter.post('/sync/employees/:employeeId/deactivate', ...run('hikvision.sync.employee', (c, ctx, b, p) => adminSync.deactivateEmployee(c, ctx, Number(p.employeeId), b)));
hikvisionOpsRouter.post('/sync/employees/:employeeId/disable', ...run('hikvision.sync.remove_access', (c, ctx, b, p) => adminSync.disableAccess(c, ctx, Number(p.employeeId), b)));
hikvisionOpsRouter.post('/sync/employees/:employeeId/remove-access', ...run('hikvision.sync.remove_access', (c, ctx, b, p) => adminSync.removeDeviceAccess(c, ctx, Number(p.employeeId), b)));

// ---- Attendance (nested convenience surface under the module) ----
registerAttendanceRoutes(hikvisionOpsRouter);

// ============================================================================
// Standalone attendance API (/api/attendance) - the integration contract
// ============================================================================
export const hikvisionAttendanceOpsRouter = Router();
registerAttendanceRoutes(hikvisionAttendanceOpsRouter);

// POST /approve - approve an attendance period by { periodId }
hikvisionAttendanceOpsRouter.post('/approve', ...run('hr.attendance.approve', (c, ctx, b) => {
  const periodId = Number(b?.periodId ?? 0);
  if (!Number.isInteger(periodId) || periodId < 1) throw badRequest('periodId is required');
  return adminAttendance.approveAttendancePeriod(c, ctx, periodId, b);
}));