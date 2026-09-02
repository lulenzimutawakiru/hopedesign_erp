import { Router } from 'express';
import { query, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { generateQr, scanQr, findQrByCode, voidQr, printLabels } from '../services/qr.js';
import {
  generateReams,
  scanReamForPacking,
  sealCarton,
  getReamByCode,
  getCartonByCode,
  createProductionBatch,
  getPackingSummary,
  getBatchCapacity,
} from '../services/reams.js';
import { spoolLabels, fetchSpool, markLabelPrinted, markLabelFailed } from '../services/niimbot.js';
import {
  listLabelTemplates,
  getLabelTemplate,
  createLabelTemplate,
  updateLabelTemplate,
  setDefaultLabelTemplate,
  archiveLabelTemplate,
} from '../services/labelTemplates.js';
import { asyncHandler, badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { qrScanLimiter } from '../middleware/rateLimits.js';

export const qrRouter = Router();

qrRouter.post(
  '/generate',
  requirePermission('qr.codes.generate'),
  asyncHandler(async (req, res) => {
    const entityType = String(req.body?.entityType ?? '').toUpperCase();
    if (!entityType) throw badRequest('entityType is required');
    const out = await tx(
      (client) =>
        generateQr(client, req.ctx, {
          entityType,
          entityId: req.body?.entityId != null ? Number(req.body.entityId) : null,
          productId: req.body?.productId != null ? Number(req.body.productId) : null,
          batchId: req.body?.batchId != null ? Number(req.body.batchId) : null,
          count: req.body?.count != null ? Math.max(1, Math.min(100, Number(req.body.count))) : 1,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.post(
  '/scan',
  qrScanLimiter,
requirePermission('qr.scans.perform'),
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code ?? '').trim();
    if (!code) throw badRequest('code is required');
    const out = await tx(
      (client) =>
        scanQr(client, req.ctx, {
          code,
          action: req.body?.action ? String(req.body.action).toUpperCase() : undefined,
          location: req.body?.location != null ? String(req.body.location) : null,
          device: req.body?.device != null ? String(req.body.device) : null,
          secret: req.body?.secret != null ? String(req.body.secret) : null,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.get(
  '/traceability/:code',
  requirePermission('qr.traceability.view'),
  asyncHandler(async (req, res) => {
    const code = String(req.params.code).trim();
    const lineage = await query(
      `SELECT v.* FROM v_qr_lineage v
       WHERE v.qr_code = $1 AND v.tenant_id = $2`,
      [code, req.ctx.tenantId],
      req.ctx
    );
    if (lineage.rows.length === 0) throw notFound('QR code not found');
    const qr = lineage.rows[0];
    const movements = await query(
      `SELECT im.*, w.code AS warehouse_code, w.name AS warehouse_name
       FROM inventory_movements im
       LEFT JOIN warehouses w ON w.id = im.warehouse_id
       WHERE im.qr_id = $1 OR (im.product_id = $2 AND im.batch_id IS NOT DISTINCT FROM $3)
       ORDER BY im.created_at, im.id`,
      [qr.qr_id, qr.product_id, qr.batch_id],
      req.ctx
    );
    const custody = await query(
      `SELECT sce.*, (u.first_name || ' ' || u.last_name) AS actor_name
       FROM secure_custody_events sce
       LEFT JOIN users u ON u.id = sce.from_user_id
       WHERE sce.job_id = $1 ORDER BY sce.occurred_at, sce.id`,
      [qr.entity_id],
      req.ctx
    ).catch(() => ({ rows: [] }));
    res.json({
      data: {
        qr: toCamelRow(qr as Record<string, unknown>),
        movements: toCamelRows(movements.rows as Record<string, unknown>[]),
        custodyEvents: toCamelRows(custody.rows as Record<string, unknown>[]),
      },
    });
  })
);

qrRouter.post(
  '/labels/print',
  requirePermission('qr.labels.print'),
  asyncHandler(async (req, res) => {
    const qrIds = Array.isArray(req.body?.qrIds) ? req.body.qrIds.map(Number) : [];
    if (qrIds.length === 0) throw badRequest('qrIds is required');
    const out = await tx(
      (client) =>
        printLabels(client, req.ctx, {
          qrIds,
          templateId: req.body?.templateId != null ? Number(req.body.templateId) : null,
          copies: req.body?.copies != null ? Math.max(1, Number(req.body.copies)) : 1,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

// ---- Ream authenticity: one unique QR per ream, 5 reams seal into one carton QR ----

qrRouter.post(
  '/batches',
  requirePermission('qr.reams.generate'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.body?.productId);
    if (!Number.isFinite(productId)) throw badRequest('productId is required');
    const out = await tx(
      (client) =>
        createProductionBatch(client, req.ctx, {
          productId,
          quantity: req.body?.quantity != null ? Number(req.body.quantity) : null,
          lotNo: req.body?.lotNo != null ? String(req.body.lotNo) : null,
          expiryDate: req.body?.expiryDate != null ? String(req.body.expiryDate) : null,
          notes: req.body?.notes != null ? String(req.body.notes) : null,
        }),
      req.ctx
    );
    res.status(201).json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.post(
  '/reams/generate',
  requirePermission('qr.reams.generate'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.body?.productId);
    if (!Number.isFinite(productId)) throw badRequest('productId is required');
    const out = await tx(
      (client) =>
        generateReams(client, req.ctx, {
          productId,
          batchId: req.body?.batchId != null ? Number(req.body.batchId) : null,
          count: req.body?.count != null ? Number(req.body.count) : 1,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.get(
  '/reams/:code',
  requirePermission('qr.reams.view'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => getReamByCode(client, req.ctx, String(req.params.code).trim()), req.ctx);
    if (!out) throw notFound('Ream not found');
    res.json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.get(
  '/cartons/:code',
  requirePermission('qr.cartons.view'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => getCartonByCode(client, req.ctx, String(req.params.code).trim()), req.ctx);
    if (!out) throw notFound('Carton not found');
    res.json({
      data: {
        ...toCamelRow(out as Record<string, unknown>),
        members: toCamelRows((out as { members: Record<string, unknown>[] }).members),
      },
    });
  })
);

qrRouter.post(
  '/packing/scan',
  qrScanLimiter,
requirePermission('qr.packing.scan'),
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code ?? '').trim();
    if (!code) throw badRequest('code is required');
    const out = await tx(
      (client) =>
        scanReamForPacking(client, req.ctx, {
          code,
          secret: req.body?.secret != null ? String(req.body.secret) : null,
          location: req.body?.location != null ? String(req.body.location) : null,
        }),
      req.ctx
    );
    res.json({ data: { ...out, ream: toCamelRow(out.ream as Record<string, unknown>) } });
  })
);

qrRouter.post(
  '/packing/seal',
  requirePermission('qr.packing.seal'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.body?.productId);
    if (!Number.isFinite(productId)) throw badRequest('productId is required');
    const reamCodes = Array.isArray(req.body?.reamCodes) ? req.body.reamCodes.map(String) : [];
    const secrets = Array.isArray(req.body?.secrets)
      ? req.body.secrets.map((s: unknown) => (s == null ? null : String(s)))
      : undefined;
    const out = await tx(
      (client) =>
        sealCarton(client, req.ctx, {
          productId,
          batchId: req.body?.batchId != null ? Number(req.body.batchId) : null,
          reamCodes,
          secrets,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.get(
  '/packing/summary',
  requirePermission('qr.reams.view'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.query.productId);
    if (!Number.isFinite(productId)) throw badRequest('productId is required');
    const out = await tx(
      (client) =>
        getPackingSummary(client, req.ctx, {
          productId,
          batchId: req.query.batchId != null ? Number(req.query.batchId) : null,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.get(
  '/packing/batch-capacity',
  requirePermission('qr.reams.view'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.query.productId);
    if (!Number.isFinite(productId)) throw badRequest('productId is required');
    const out = await tx(
      (client) => getBatchCapacity(client, req.ctx, productId),
      req.ctx
    );
    res.json({ data: out });
  })
);

// ---- Niimbot label spool (prints the unique ream/carton QR labels) ----

qrRouter.post(
  '/labels/spool',
  requirePermission('qr.labels.print'),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = await tx(
      (client) =>
        spoolLabels(client, req.ctx, {
          items: items.map((it: { qrId?: unknown; payload?: unknown }) => ({
            qrId: Number(it?.qrId),
            payload: String(it?.payload ?? ''),
          })),
          templateId: req.body?.templateId != null ? Number(req.body.templateId) : null,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);


// ---- Label varieties (selectable ream/carton label templates) ----

qrRouter.get(
  '/labels/templates',
  requirePermission('qr.templates.view'),
  asyncHandler(async (req, res) => {
    const rows = await tx(
      (client) =>
        listLabelTemplates(client, req.ctx, {
          kind: req.query.kind != null ? String(req.query.kind) : undefined,
          activeOnly: req.query.activeOnly === '1' || req.query.activeOnly === 'true',
        }),
      req.ctx
    );
    res.json({ data: toCamelRows(rows as Record<string, unknown>[]) });
  })
);

qrRouter.post(
  '/labels/templates',
  requirePermission('qr.templates.create'),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) =>
        createLabelTemplate(client, req.ctx, {
          code: req.body?.code != null ? String(req.body.code) : undefined,
          name: req.body?.name != null ? String(req.body.name) : undefined,
          kind: req.body?.kind != null ? String(req.body.kind) : undefined,
          content: req.body?.content,
          mmWidth: req.body?.mmWidth,
          mmHeight: req.body?.mmHeight,
          printerModel: req.body?.printerModel != null ? String(req.body.printerModel) : null,
          isDefault: !!req.body?.isDefault,
        }),
      req.ctx
    );
    res.status(201).json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.patch(
  '/labels/templates/:id',
  requirePermission('qr.templates.update'),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) =>
        updateLabelTemplate(client, req.ctx, Number(req.params.id), {
          code: req.body?.code != null ? String(req.body.code) : undefined,
          name: req.body?.name != null ? String(req.body.name) : undefined,
          kind: req.body?.kind != null ? String(req.body.kind) : undefined,
          content: req.body?.content,
          mmWidth: req.body?.mmWidth,
          mmHeight: req.body?.mmHeight,
          printerModel: req.body?.printerModel != null ? String(req.body.printerModel) : null,
          isDefault: req.body?.isDefault,
          isActive: req.body?.isActive,
        }),
      req.ctx
    );
    res.json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.post(
  '/labels/templates/:id/default',
  requirePermission('qr.templates.update'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => setDefaultLabelTemplate(client, req.ctx, Number(req.params.id)), req.ctx);
    res.json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.delete(
  '/labels/templates/:id',
  requirePermission('qr.templates.delete'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => archiveLabelTemplate(client, req.ctx, Number(req.params.id)), req.ctx);
    res.json({ data: out });
  })
);

qrRouter.get(
  '/labels/spool',
  requirePermission('qr.labels.print'),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fetchSpool(client, req.ctx, { limit: Number(req.query.limit) || 10 }),
      req.ctx
    );
    res.json({ data: out });
  })
);

qrRouter.post(
  '/labels/:id/printed',
  requirePermission('qr.labels.print'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const out = await tx((client) => markLabelPrinted(client, req.ctx, id), req.ctx);
    res.json({ data: out });
  })
);

qrRouter.post(
  '/labels/:id/failed',
  requirePermission('qr.labels.print'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reason = req.body?.reason != null ? String(req.body.reason) : undefined;
    const out = await tx((client) => markLabelFailed(client, req.ctx, id, reason), req.ctx);
    res.json({ data: out });
  })
);

qrRouter.get(
  '/:code',
  requirePermission('qr.codes.view'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => findQrByCode(client, req.ctx, String(req.params.code).trim()), req.ctx);
    if (!out) throw notFound('QR code not found');
    res.json({ data: toCamelRow(out as Record<string, unknown>) });
  })
);

qrRouter.post(
  '/:id/void',
  requirePermission('qr.codes.void'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reason = String(req.body?.reason ?? '').trim() || 'Voided by user';
    const out = await tx((client) => voidQr(client, req.ctx, id, reason), req.ctx);
    res.json({ data: out });
  })
);
