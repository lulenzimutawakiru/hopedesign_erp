import { Router } from 'express';
import pg from 'pg';
import { tx, pool, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler } from '../utils.js';
import {
  getHealth,
  getStorage,
  getConnections,
  getQueries,
  getIndexes,
  runIntegrityChecks,
  getIntegrityHistory,
  getDataQuality,
  getRetentionPolicies,
  updateRetentionPolicy,
  getSettings,
  updateSettings,
  getMigrationAudit,
  recordMigrationEvent,
  getBackups,
  createBackup,
  requestRestore,
  approveRestore,
  getAudit,
  getLocks,
  runMaintenance,
} from '../services/database-admin.js';

export const databaseAdminRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

type QueryFn = (client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
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

databaseAdminRouter.get('/health', runGet('database.health.view', (c, ctx) => getHealth(c, ctx)));
databaseAdminRouter.get('/storage', runGet('database.schema.view', (c, ctx) => getStorage(c, ctx)));
databaseAdminRouter.get('/connections', runGet('database.connections.view', (c, ctx) => getConnections(c, ctx)));
databaseAdminRouter.get('/queries', runGet('database.activity.view', (c, ctx) => getQueries(c, ctx)));
databaseAdminRouter.get('/locks', runGet('database.locks.view', (c, ctx) => getLocks(c, ctx)));
databaseAdminRouter.get('/indexes', runGet('database.index.view', (c, ctx) => getIndexes(c, ctx)));
databaseAdminRouter.get('/integrity', runGet('database.integrity.run', (c, ctx) => getIntegrityHistory(c, ctx)));
databaseAdminRouter.post('/integrity/run', run('database.integrity.run', (c, ctx) => runIntegrityChecks(c, ctx)));
databaseAdminRouter.get('/data-quality', runGet('database.data_quality.view', (c, ctx) => getDataQuality(c, ctx)));
databaseAdminRouter.get('/retention', runGet('database.retention.manage', (c, ctx) => getRetentionPolicies(c, ctx)));
databaseAdminRouter.put(
  '/retention/:id',
  run('database.retention.manage', (c, ctx, body, params) => updateRetentionPolicy(c, ctx, Number(params.id), body))
);
databaseAdminRouter.get('/settings', runGet('database.settings.manage', (c, ctx) => getSettings(c, ctx)));
databaseAdminRouter.put('/settings', run('database.settings.manage', (c, ctx, body) => updateSettings(c, ctx, body)));
databaseAdminRouter.get('/migrations', runGet('database.migration.view', (c, ctx) => getMigrationAudit(c, ctx)));
databaseAdminRouter.post('/migrations', run('database.migration.execute', (c, ctx, body) => recordMigrationEvent(c, ctx, body)));
databaseAdminRouter.get('/backups', runGet('database.backup.view', (c, ctx) => getBackups(c, ctx)));
databaseAdminRouter.post('/maintenance', [
  requirePermission('database.maintenance.run'),
  asyncHandler(async (req, res) => {
    const out = await runMaintenance(pool, req.ctx, req.body ?? {});
    res.json({ data: out });
  }),
]);
databaseAdminRouter.post('/backups', run('database.backup.create', (c, ctx, body) => createBackup(c, ctx, body)));
databaseAdminRouter.post(
  '/backups/:id/restore',
  run('database.restore.request', (c, ctx, body, params) => requestRestore(c, ctx, { ...body, backupId: Number(params.id) }))
);
databaseAdminRouter.post(
  '/restores/:id/decision',
  run('database.restore.approve', (c, ctx, body, params) => approveRestore(c, ctx, Number(params.id), body))
);
databaseAdminRouter.get('/audit', runGet('database.audit.view', (c, ctx, q) => getAudit(c, ctx, q.limit ? Number(q.limit) : 300)));
