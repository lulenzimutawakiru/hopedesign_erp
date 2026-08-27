import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as ast from '../../services/assets.js';

export const assetsOpsRouter = Router();
const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// ---- Asset Management Command Centre ----
assetsOpsRouter.get('/dashboard/kpis', ...runGet('assets.dashboards.view', (c, ctx) => ast.dashboardKpis(c, ctx)));

// ---- Mobile verification queue ----
assetsOpsRouter.get('/verification', ...runGet('assets.register.view', (c, ctx, q) => ast.verificationList(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  locationId: q.locationId != null && q.locationId !== '' ? Number(q.locationId) : null,
  departmentId: q.departmentId != null && q.departmentId !== '' ? Number(q.departmentId) : null,
  dueOnly: q.dueOnly === '1' || q.dueOnly === 'true',
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/verification/verify', ...run('assets.register.verify', (c, ctx, b) => ast.verifyAsset(c, ctx, b)));

// ---- Asset register ----
assetsOpsRouter.get('/', ...runGet('assets.register.view', (c, ctx, q) => ast.listAssets(c, ctx, {
  search: q.search != null ? String(q.search) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  condition: q.condition != null ? String(q.condition) : undefined,
  categoryId: q.categoryId != null && q.categoryId !== '' ? Number(q.categoryId) : undefined,
  typeId: q.typeId != null && q.typeId !== '' ? Number(q.typeId) : undefined,
  locationId: q.locationId != null && q.locationId !== '' ? Number(q.locationId) : undefined,
  custodianId: q.custodianId != null && q.custodianId !== '' ? Number(q.custodianId) : undefined,
  departmentId: q.departmentId != null && q.departmentId !== '' ? Number(q.departmentId) : undefined,
  branchId: q.branchId != null && q.branchId !== '' ? Number(q.branchId) : undefined,
  supplierId: q.supplierId != null && q.supplierId !== '' ? Number(q.supplierId) : undefined,
  isMachine: q.isMachine === '1' || q.isMachine === 'true',
  highValue: q.highValue === '1' || q.highValue === 'true',
  unassigned: q.unassigned === '1' || q.unassigned === 'true',
  dueMaintenance: q.dueMaintenance === '1' || q.dueMaintenance === 'true',
  dueInspection: q.dueInspection === '1' || q.dueInspection === 'true',
  nearEol: q.nearEol === '1' || q.nearEol === 'true',
  mine: q.mine === '1' || q.mine === 'true',
  includeDisposed: q.includeDisposed === '1' || q.includeDisposed === 'true',
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
  sortBy: q.sortBy != null ? String(q.sortBy) : undefined,
  sortDir: q.sortDir != null ? (String(q.sortDir) as 'asc' | 'desc') : undefined,
})));
assetsOpsRouter.post('/', ...run('assets.register.create', (c, ctx, b) => ast.createAsset(c, ctx, b)));
assetsOpsRouter.patch('/:id', ...run('assets.register.update', (c, ctx, b, p) => ast.updateAsset(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/:id/submit', ...run('assets.register.submit', (c, ctx, _b, p) => ast.submitAsset(c, ctx, Number(p.id))));
assetsOpsRouter.post('/:id/capitalize', ...run('assets.register.capitalize', (c, ctx, b, p) => ast.capitalizeAsset(c, ctx, Number(p.id), b)));

// ---- Asset tags (QR / barcode) ----
assetsOpsRouter.get('/tags', ...runGet('assets.tags.view', (c, ctx, q) => ast.listTags(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/tags/events', ...runGet('assets.tags.view', (c, ctx, q) => ast.listTagEvents(c, ctx, {
  tagId: q.tagId != null && q.tagId !== '' ? Number(q.tagId) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/tags/print-jobs', ...runGet('assets.tags.view', (c, ctx, q) => ast.listTagPrintJobs(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/tags/print-jobs/:id', ...runGet('assets.tags.view', (c, ctx, _q, p) => ast.getTagPrintJob(c, ctx, Number(p.id))));
assetsOpsRouter.post('/tags/generate-bulk', ...run('assets.tags.generate', (c, ctx, b) => ast.generateBulkTags(c, ctx, b)));
assetsOpsRouter.post('/tags/:tagId/void', ...run('assets.tags.void', (c, ctx, b, p) => ast.voidTag(c, ctx, Number(p.tagId), b)));
assetsOpsRouter.post('/tags/:tagId/attach', ...run('assets.tags.generate', (c, ctx, _b, p) => ast.attachTag(c, ctx, Number(p.tagId))));
assetsOpsRouter.post('/tags/:tagId/verify', ...run('assets.tags.generate', (c, ctx, _b, p) => ast.verifyTag(c, ctx, Number(p.tagId))));
assetsOpsRouter.post('/:id/tags', ...run('assets.tags.generate', (c, ctx, b, p) => ast.generateTag(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/:id/tags/print', ...run('assets.tags.print', (c, ctx, b, p) => ast.printTags(c, ctx, { ...b, assetIds: [Number(p.id)] })));
assetsOpsRouter.post('/:id/tags/replace', ...run('assets.tags.replace', (c, ctx, b, p) => ast.replaceTag(c, ctx, Number(p.id), b)));

// ---- Global asset scanning & anomaly detection ----
assetsOpsRouter.post('/scans', ...run('assets.scans.perform', (c, ctx, b) => ast.scanAsset(c, ctx, b)));
assetsOpsRouter.get('/scans', ...runGet('assets.scans.view', (c, ctx, q) => ast.listScans(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  result: q.result != null ? String(q.result) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/anomalies', ...runGet('assets.anomalies.view', (c, ctx, q) => ast.listAnomalies(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/anomalies/:id/resolve', ...run('assets.anomalies.resolve', (c, ctx, b, p) => ast.resolveAnomaly(c, ctx, Number(p.id), b)));
// ---- Custody & assignment ----
assetsOpsRouter.get('/custody', ...runGet('assets.custodians.view', (c, ctx, q) => ast.listCustody(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  custodianUserId: q.custodianUserId != null && q.custodianUserId !== '' ? Number(q.custodianUserId) : undefined,
  current: q.current === 'true' || q.current === 'false' ? q.current === 'true' : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/custody/:custodyId/accept', ...run('assets.assignments.complete', (c, ctx, _b, p) => ast.acceptAssignment(c, ctx, Number(p.custodyId))));
assetsOpsRouter.post('/:id/assign', ...run('assets.assignments.create', (c, ctx, b, p) => ast.assignAsset(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/:id/return', ...run('assets.assignments.return', (c, ctx, b, p) => ast.returnAsset(c, ctx, Number(p.id), b)));

// ---- Asset transfers ----
assetsOpsRouter.get('/transfers', ...runGet('assets.transfers.view', (c, ctx, q) => ast.listTransfers(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  transferType: q.transferType != null ? String(q.transferType) : undefined,
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/transfers', ...run('assets.transfers.create', (c, ctx, b) => ast.requestTransfer(c, ctx, b)));
assetsOpsRouter.get('/transfers/:id', ...runGet('assets.transfers.view', (c, ctx, _q, p) => ast.getTransfer(c, ctx, Number(p.id))));
assetsOpsRouter.post('/transfers/:id/complete', ...run('assets.transfers.complete', (c, ctx, b, p) => ast.completeTransfer(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/transfers/:id/approve', ...run('assets.transfers.approve', (c, ctx, _b, p) => ast.approveTransfer(c, ctx, Number(p.id))));

// ---- Missing / lost assets (controlled workflow) ----
assetsOpsRouter.post('/:id/missing', ...run('assets.register.update', (c, ctx, b, p) => ast.reportMissing(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/:id/missing/escalate', ...run('assets.register.update', (c, ctx, b, p) => ast.escalateMissing(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/:id/missing/recover', ...run('assets.register.update', (c, ctx, b, p) => ast.recoverMissing(c, ctx, Number(p.id), b)));

// ---- Maintenance (preventive / corrective / emergency) ----
assetsOpsRouter.get('/maintenance', ...runGet('assets.maintenance.view', (c, ctx, q) => ast.listMaintenanceWorkOrders(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  maintenanceType: q.maintenanceType != null ? String(q.maintenanceType) : undefined,
  priority: q.priority != null ? String(q.priority) : undefined,
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/maintenance', ...run('assets.maintenance.create', (c, ctx, b) => ast.createMaintenanceWorkOrder(c, ctx, b)));
assetsOpsRouter.get('/maintenance/:id', ...runGet('assets.maintenance.view', (c, ctx, _q, p) => ast.getMaintenanceWorkOrder(c, ctx, Number(p.id))));
assetsOpsRouter.post('/maintenance/:id/update', ...run('assets.maintenance.update', (c, ctx, b, p) => ast.updateMaintenanceWorkOrder(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/maintenance/:id/submit', ...run('assets.maintenance.submit', (c, ctx, _b, p) => ast.submitMaintenanceWorkOrder(c, ctx, Number(p.id))));
assetsOpsRouter.post('/maintenance/:id/complete', ...run('assets.maintenance.complete', (c, ctx, b, p) => ast.completeMaintenanceWorkOrder(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/maintenance/:id/cancel', ...run('assets.maintenance.cancel', (c, ctx, b, p) => ast.cancelMaintenanceWorkOrder(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/maintenance/:id/approve', ...run('assets.maintenance.approve', (c, ctx, _b, p) => ast.approveMaintenance(c, ctx, Number(p.id))));
// ---- Periodic asset audits ----
assetsOpsRouter.get('/audits', ...runGet('assets.audits.view', (c, ctx, q) => ast.listAudits(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  auditType: q.auditType != null ? String(q.auditType) : undefined,
  branchId: q.branchId != null && q.branchId !== '' ? Number(q.branchId) : undefined,
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/audits/dashboard', ...runGet('assets.audits.view', (c, ctx, q) => ast.auditDashboard(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  auditType: q.auditType != null ? String(q.auditType) : undefined,
})));
assetsOpsRouter.post('/audits', ...run('assets.audits.create', (c, ctx, b) => ast.createAudit(c, ctx, b)));
assetsOpsRouter.get('/audits/:id', ...runGet('assets.audits.view', (c, ctx, _q, p) => ast.getAudit(c, ctx, Number(p.id))));
assetsOpsRouter.post('/audits/:id/update', ...run('assets.audits.update', (c, ctx, b, p) => ast.updateAudit(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/audits/:id/start', ...run('assets.audits.update', (c, ctx, _b, p) => ast.startAudit(c, ctx, Number(p.id))));
assetsOpsRouter.post('/audits/:id/submit', ...run('assets.audits.submit', (c, ctx, _b, p) => ast.submitAudit(c, ctx, Number(p.id))));
assetsOpsRouter.post('/audits/:id/approve', ...run('assets.audits.approve', (c, ctx, _b, p) => ast.approveAudit(c, ctx, Number(p.id))));
assetsOpsRouter.post('/audits/:id/close', ...run('assets.audits.close', (c, ctx, _b, p) => ast.closeAudit(c, ctx, Number(p.id))));
assetsOpsRouter.post('/audits/:id/cancel', ...run('assets.audits.cancel', (c, ctx, b, p) => ast.cancelAudit(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/audits/:id/scan', ...run('assets.audits.update', (c, ctx, b, p) => ast.auditScan(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/audits/:id/items/:itemId', ...run('assets.audit_items.update', (c, ctx, b, p) => ast.updateAuditItem(c, ctx, Number(p.id), Number(p.itemId), b)));
assetsOpsRouter.post('/audits/:id/exceptions', ...run('assets.audits.update', (c, ctx, b, p) => ast.addAuditException(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/exceptions/:exceptionId/resolve', ...run('assets.audits.update', (c, ctx, b, p) => ast.resolveAuditException(c, ctx, Number(p.exceptionId), b)));

// ---- Disposal (dual control for high value) ----
assetsOpsRouter.get('/disposals', ...runGet('assets.disposals.view', (c, ctx, q) => ast.listDisposals(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/disposals', ...run('assets.disposals.create', (c, ctx, b) => ast.createDisposal(c, ctx, b)));
assetsOpsRouter.get('/disposals/:id', ...runGet('assets.disposals.view', (c, ctx, _q, p) => ast.getDisposal(c, ctx, Number(p.id))));
assetsOpsRouter.post('/disposals/:id/update', ...run('assets.disposals.update', (c, ctx, b, p) => ast.updateDisposal(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/disposals/:id/submit', ...run('assets.disposals.submit', (c, ctx, _b, p) => ast.submitDisposal(c, ctx, Number(p.id))));
assetsOpsRouter.post('/disposals/:id/approve', ...run('assets.disposals.approve', (c, ctx, _b, p) => ast.approveDisposal(c, ctx, Number(p.id))));
assetsOpsRouter.post('/disposals/:id/set-stage', ...run('assets.disposals.update', (c, ctx, b, p) => ast.setDisposalStage(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/disposals/:id/cancel', ...run('assets.disposals.cancel', (c, ctx, b, p) => ast.cancelDisposal(c, ctx, Number(p.id), b)));

// ---- Depreciation ----
assetsOpsRouter.get('/depreciation', ...runGet('assets.depreciation.view', (c, ctx, q) => ast.listDepreciations(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  method: q.method != null ? String(q.method) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/depreciation/schedule/:assetId', ...runGet('assets.depreciation.view', (c, ctx, _q, p) => ast.getDepreciationSchedule(c, ctx, Number(p.assetId))));
assetsOpsRouter.post('/depreciation/run', ...run('assets.depreciation.post', (c, ctx, b) => ast.runDepreciation(c, ctx, b)));
assetsOpsRouter.post('/:assetId/depreciation/setup', ...run('assets.depreciation.create', (c, ctx, b, p) => ast.setupDepreciation(c, ctx, Number(p.assetId), b)));
assetsOpsRouter.post('/:assetId/depreciation/post', ...run('assets.depreciation.post', (c, ctx, b, p) => ast.postDepreciation(c, ctx, Number(p.assetId), b)));

// ---- Impairment ----
assetsOpsRouter.get('/impairments', ...runGet('assets.impairments.view', (c, ctx, q) => ast.listImpairments(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  type: q.type != null ? String(q.type) : undefined,
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/impairments', ...run('assets.impairments.create', (c, ctx, b) => ast.createImpairment(c, ctx, b)));
assetsOpsRouter.get('/impairments/:id', ...runGet('assets.impairments.view', (c, ctx, _q, p) => ast.getImpairment(c, ctx, Number(p.id))));
assetsOpsRouter.post('/impairments/:id/submit', ...run('assets.impairments.submit', (c, ctx, _b, p) => ast.submitImpairment(c, ctx, Number(p.id))));
assetsOpsRouter.post('/impairments/:id/approve', ...run('assets.impairments.approve', (c, ctx, _b, p) => ast.approveImpairment(c, ctx, Number(p.id))));
assetsOpsRouter.post('/impairments/:id/cancel', ...run('assets.impairments.cancel', (c, ctx, b, p) => ast.cancelImpairment(c, ctx, Number(p.id), b)));
// ---- Warranties ----
assetsOpsRouter.get('/warranties', ...runGet('assets.warranties.view', (c, ctx, q) => ast.listWarranties(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  active: q.active === '1' || q.active === 'true',
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/warranties', ...run('assets.warranties.create', (c, ctx, b) => ast.createWarranty(c, ctx, b)));
assetsOpsRouter.get('/warranties/:id', ...runGet('assets.warranties.view', (c, ctx, _q, p) => ast.getWarranty(c, ctx, Number(p.id))));
assetsOpsRouter.post('/warranties/:id/update', ...run('assets.warranties.update', (c, ctx, b, p) => ast.updateWarranty(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/warranties/:id/deactivate', ...run('assets.warranties.delete', (c, ctx, b, p) => ast.deactivateWarranty(c, ctx, Number(p.id), b)));

// ---- Insurance ----
assetsOpsRouter.get('/insurance', ...runGet('assets.insurance.view', (c, ctx, q) => ast.listInsurance(c, ctx, {
  assetId: q.assetId != null && q.assetId !== '' ? Number(q.assetId) : undefined,
  active: q.active === '1' || q.active === 'true',
  search: q.search != null ? String(q.search) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/insurance', ...run('assets.insurance.create', (c, ctx, b) => ast.createInsurance(c, ctx, b)));
assetsOpsRouter.get('/insurance/:id', ...runGet('assets.insurance.view', (c, ctx, _q, p) => ast.getInsurance(c, ctx, Number(p.id))));
assetsOpsRouter.post('/insurance/:id/update', ...run('assets.insurance.update', (c, ctx, b, p) => ast.updateInsurance(c, ctx, Number(p.id), b)));
assetsOpsRouter.post('/insurance/:id/deactivate', ...run('assets.insurance.delete', (c, ctx, b, p) => ast.deactivateInsurance(c, ctx, Number(p.id), b)));

// ---- Asset documents ----
assetsOpsRouter.get('/:id/documents', ...runGet('assets.documents.view', (c, ctx, _q, p) => ast.listAssetDocuments(c, ctx, Number(p.id))));
assetsOpsRouter.post('/:id/documents', requirePermission('assets.documents.create'), assetUpload.single('file'), asyncHandler(async (req, res) => {
  const file = req.file
    ? { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, buffer: req.file.buffer }
    : undefined;
  const out = await tx(
    (client) => ast.attachDocument(client, req.ctx, Number(req.params.id), {
      title: req.body?.title != null ? String(req.body.title) : undefined,
      category: req.body?.category != null ? String(req.body.category) : undefined,
      ...(file ? { file } : {}),
    }),
    req.ctx
  );
  res.json({ data: out });
}));
assetsOpsRouter.delete('/:id/documents/:documentId', requirePermission('assets.documents.delete'), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => ast.removeDocumentLink(client, req.ctx, Number(req.params.id), Number(req.params.documentId), {
      reason: req.body?.reason != null ? String(req.body.reason) : undefined,
    }),
    req.ctx
  );
  res.json({ data: out });
}));
assetsOpsRouter.get('/:id/documents/:documentId/file', requirePermission('assets.documents.download'), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => ast.getAssetDocumentFile(client, req.ctx, Number(req.params.id), Number(req.params.documentId)),
    req.ctx
  );
  res.setHeader('Content-Type', out.mimeType);
  res.setHeader('Content-Length', String(out.sizeBytes));
  res.setHeader('Content-Disposition', `attachment; filename="${out.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.buffer);
}));

// ---- Asset photos ----
assetsOpsRouter.get('/:id/photos', ...runGet('assets.photos.view', (c, ctx, _q, p) => ast.listAssetPhotos(c, ctx, Number(p.id))));
assetsOpsRouter.post('/:id/photos', requirePermission('assets.photos.create'), assetUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('A photo file is required (field "file")');
  const out = await tx(
    (client) => ast.attachPhoto(client, req.ctx, Number(req.params.id), {
      category: req.body?.category != null ? String(req.body.category) : undefined,
      file: { originalname: req.file!.originalname, mimetype: req.file!.mimetype, size: req.file!.size, buffer: req.file!.buffer },
    }),
    req.ctx
  );
  res.json({ data: out });
}));
assetsOpsRouter.delete('/:id/photos/:photoId', requirePermission('assets.photos.delete'), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => ast.deletePhoto(client, req.ctx, Number(req.params.id), Number(req.params.photoId), {
      reason: req.body?.reason != null ? String(req.body.reason) : undefined,
    }),
    req.ctx
  );
  res.json({ data: out });
}));

// ---- Comments / timeline / movement map ----
assetsOpsRouter.get('/:id/comments', ...runGet('assets.register.view', (c, ctx, _q, p) => ast.listAssetComments(c, ctx, Number(p.id))));
assetsOpsRouter.post('/:id/comments', ...run('assets.register.comment', (c, ctx, b, p) => ast.addAssetComment(c, ctx, Number(p.id), b)));
assetsOpsRouter.get('/:id/timeline', ...runGet('assets.timeline.view', (c, ctx, q, p) => ast.getAssetTimeline(c, ctx, Number(p.id), {
  eventType: q.eventType != null ? String(q.eventType) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.get('/:id/movements', ...runGet('assets.timeline.view', (c, ctx, _q, p) => ast.assetMovementMap(c, ctx, Number(p.id))));

// ---- Export / import (RBAC + ABAC scoped) ----
assetsOpsRouter.get('/export', requirePermission('assets.exports.create'), asyncHandler(async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const out = await tx(
    (client) => ast.exportAssets(client, req.ctx, {
      format: q.format != null ? String(q.format) : 'pdf',
      reportType: q.reportType != null ? String(q.reportType) : undefined,
      filters: {
        search: q.search != null ? String(q.search) : undefined,
        status: q.status != null ? String(q.status) : undefined,
        categoryId: q.categoryId != null && q.categoryId !== '' ? Number(q.categoryId) : undefined,
        locationId: q.locationId != null && q.locationId !== '' ? Number(q.locationId) : undefined,
        custodianId: q.custodianId != null && q.custodianId !== '' ? Number(q.custodianId) : undefined,
        branchId: q.branchId != null && q.branchId !== '' ? Number(q.branchId) : undefined,
        departmentId: q.departmentId != null && q.departmentId !== '' ? Number(q.departmentId) : undefined,
        isMachine: q.isMachine === '1' || q.isMachine === 'true',
      },
    }),
    req.ctx
  );
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Length', String(out.buffer.length));
  res.setHeader('Content-Disposition', `attachment; filename="asset-register.${out.extension}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.buffer);
}));
assetsOpsRouter.get('/export-jobs', ...runGet('assets.exports.view', (c, ctx, q) => ast.listExportJobs(c, ctx, {
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
assetsOpsRouter.post('/import', requirePermission('assets.imports.create'), assetUpload.single('file'), asyncHandler(async (req, res) => {
  const file = req.file
    ? { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, buffer: req.file.buffer }
    : undefined;
  const out = await tx(
    (client) => ast.importAssets(client, req.ctx, {
      fileName: req.body?.fileName != null ? String(req.body.fileName) : undefined,
      ...(file ? { file } : {}),
    }),
    req.ctx
  );
  res.json({ data: out });
}));
assetsOpsRouter.get('/import-jobs', ...runGet('assets.imports.view', (c, ctx, q) => ast.listImportJobs(c, ctx, {
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));

// ---- Asset 360 (catch-all single-segment; register last) ----
assetsOpsRouter.get('/:id', ...runGet('assets.register.view', (c, ctx, _q, p) => ast.asset360(c, ctx, Number(p.id))));
