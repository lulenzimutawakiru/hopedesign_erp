import { Router } from 'express';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { tx, pool, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import {
  asyncHandler,
  badRequest,
  notFound,
  parsePagination,
  toCamelRow,
  toCamelRows,
} from '../../utils.js';
import { config } from '../../config.js';
import { logAudit } from '../../services/audit.js';
import { notifyUsers } from '../../services/communication.js';

export const documentsOpsRouter = Router();

const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

const stripTotal = (r: Record<string, unknown>): Record<string, unknown> => {
  const { _total, ...rest } = r;
  return rest;
};

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === '1';

const CATEGORIES = ['POLICY','PROCEDURE','CONTRACT','CERTIFICATE','QUALITY','MAINTENANCE','PRODUCTION','HR','FINANCE','PURCHASE','SALES','LOGISTICS','ASSET','SECURITY','REPORT','OTHER'];
const CLASSIFICATIONS = ['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'];
const STATUSES = ['DRAFT','IN_REVIEW','APPROVED','RELEASED','ARCHIVED','OBSOLETE'];

function validCategory(v: unknown): string {
  const s = String(v ?? 'OTHER').toUpperCase();
  return CATEGORIES.includes(s) ? s : 'OTHER';
}

function validClassification(v: unknown): string {
  const s = String(v ?? 'INTERNAL').toUpperCase();
  return CLASSIFICATIONS.includes(s) ? s : 'INTERNAL';
}

function validStatus(v: unknown, fallback = 'DRAFT'): string {
  const s = String(v ?? fallback).toUpperCase();
  return STATUSES.includes(s) ? s : fallback;
}

function storageRel(ctx: Ctx, documentId: number, version: number, fileName: string): string {
  const ext = path.extname(fileName).replace(/[^A-Za-z0-9.]/g, '') || '.bin';
  return `dms/${ctx.tenantId}/${ctx.companyId ?? '0'}/documents/${documentId}/v${version}${ext}`;
}

function safeFileName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
}

// ---------------------------------------------------------------------------
// Command center
// ---------------------------------------------------------------------------
documentsOpsRouter.get(
  '/command',
  ...runGet('documents.command.view', async (c, ctx) => {
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL) AS total,
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
           AND status IN ('APPROVED','RELEASED')) AS released,
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
           AND status = 'IN_REVIEW') AS pending_review,
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
           AND status = 'DRAFT') AS drafts,
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
           AND status IN ('ARCHIVED','OBSOLETE')) AS archived,
         (SELECT COALESCE(sum(file_size),0)::bigint FROM dms_documents
           WHERE tenant_id = $1 AND deleted_at IS NULL) AS storage_bytes,
         (SELECT count(*)::int FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
           AND retention_until IS NOT NULL AND retention_until <= now() + interval '30 days'
           AND status NOT IN ('ARCHIVED','OBSOLETE')) AS expiring,
         (SELECT count(*)::int FROM dms_folders WHERE tenant_id = $1) AS folders`,
      [tenantId]
    );
    const k = rows[0];
    const cats = await c.query(
      `SELECT category, count(*)::int AS count
         FROM dms_documents WHERE tenant_id = $1 AND deleted_at IS NULL
        GROUP BY category ORDER BY count DESC`,
      [tenantId]
    );
    const activity = await c.query(
      `SELECT r.*, d.code AS document_code, d.title AS document_title,
              (u.first_name || ' ' || u.last_name) AS reviewer_name
         FROM dms_reviews r
         JOIN dms_documents d ON d.id = r.document_id
         LEFT JOIN users u ON u.id = r.reviewer_id
        WHERE r.tenant_id = $1 AND d.deleted_at IS NULL
        ORDER BY r.created_at DESC LIMIT 8`,
      [tenantId]
    );
    const pending = await c.query(
      `SELECT d.id, d.code, d.title, d.category, d.classification, f.name AS folder_name,
              r.created_at AS submitted_at, r.comment AS submission_note
         FROM dms_documents d
         JOIN dms_reviews r ON r.document_id = d.id AND r.action = 'SUBMITTED'
         LEFT JOIN dms_folders f ON f.id = d.folder_id
        WHERE d.tenant_id = $1 AND d.status = 'IN_REVIEW' AND d.deleted_at IS NULL
        ORDER BY r.created_at DESC LIMIT 12`,
      [tenantId]
    );
    return {
      kpis: {
        totalDocuments: Number(k.total),
        released: Number(k.released),
        pendingReview: Number(k.pending_review),
        drafts: Number(k.drafts),
        archived: Number(k.archived),
        storageBytes: Number(k.storage_bytes),
        expiringSoon: Number(k.expiring),
        folders: Number(k.folders),
      },
      categories: toCamelRows(cats.rows as Record<string, unknown>[]),
      activity: toCamelRows(activity.rows as Record<string, unknown>[]),
      pendingReview: toCamelRows(pending.rows as Record<string, unknown>[]),
    };
  })
);

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
documentsOpsRouter.get(
  '/folders',
  ...runGet('documents.view', async (c, ctx) => {
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT f.*,
              (SELECT count(*)::int FROM dms_documents d
                WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS document_count
         FROM dms_folders f
        WHERE f.tenant_id = $1
        ORDER BY f.parent_id NULLS FIRST, f.name`,
      [tenantId]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

documentsOpsRouter.post(
  '/folders',
  ...run('documents.folders.manage', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const code = String(b.code ?? '').trim().toUpperCase();
    const name = String(b.name ?? '').trim();
    if (!code || !name) throw badRequest('Folder code and name are required');
    const { rows } = await c.query(
      `INSERT INTO dms_folders (tenant_id, company_id, branch_id, parent_id, code, name, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, ctx.companyId ?? null, ctx.branchId ?? null, num(b.parentId), code, name, str(b.description), ctx.userId ?? null]
    );
    await logAudit(c, ctx, {
      action: 'DMS_FOLDER_CREATED', resource: 'dms_folder', recordId: Number(rows[0].id), recordCode: code,
      metadata: { name },
    });
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

documentsOpsRouter.patch(
  '/folders/:id',
  ...run('documents.folders.manage', async (c, ctx, b, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE dms_folders SET name = COALESCE($3, name), description = COALESCE($4, description),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, str(b.name), str(b.description)]
    );
    if (!rows.length) throw notFound('Folder not found');
    await logAudit(c, ctx, {
      action: 'DMS_FOLDER_UPDATED', resource: 'dms_folder', recordId: id, recordCode: String(rows[0].code),
    });
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Document list + recent
// ---------------------------------------------------------------------------
documentsOpsRouter.get(
  '/recent',
  ...runGet('documents.view', async (c, ctx) => {
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT d.*, f.name AS folder_name,
              (SELECT count(*)::int FROM dms_versions dv WHERE dv.document_id = d.id) AS version_count
         FROM dms_documents d
         LEFT JOIN dms_folders f ON f.id = d.folder_id
        WHERE d.tenant_id = $1 AND d.deleted_at IS NULL
          AND d.status IN ('IN_REVIEW','APPROVED','RELEASED')
        ORDER BY d.updated_at DESC LIMIT 8`,
      [tenantId]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

documentsOpsRouter.get(
  '/',
  ...runGet('documents.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const { page, pageSize, offset } = parsePagination(q);
    const where = ['d.tenant_id = $1', 'd.deleted_at IS NULL'];
    const params: unknown[] = [tenantId];
    if (q.folderId) {
      params.push(Number(q.folderId));
      where.push(`d.folder_id = $${params.length}`);
    }
    if (q.category) {
      params.push(validCategory(q.category));
      where.push(`d.category = $${params.length}`);
    }
    if (q.status) {
      params.push(validStatus(q.status));
      where.push(`d.status = $${params.length}`);
    }
    if (q.classification) {
      params.push(validClassification(q.classification));
      where.push(`d.classification = $${params.length}`);
    }
    if (q.q) {
      params.push('%' + String(q.q) + '%');
      where.push(`(d.code ILIKE $${params.length} OR d.title ILIKE $${params.length}
                   OR d.description ILIKE $${params.length})`);
    }
    if (q.tags) {
      params.push('%' + String(q.tags) + '%');
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.tags) t WHERE t ILIKE $${params.length})`);
    }
    const { rows } = await c.query(
      `SELECT d.*, f.name AS folder_name,
              (SELECT count(*)::int FROM dms_versions dv WHERE dv.document_id = d.id) AS version_count,
              COUNT(*) OVER() AS _total
         FROM dms_documents d
         LEFT JOIN dms_folders f ON f.id = d.folder_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );
    const total = rows.length ? Number(rows[0]._total) : 0;
    return {
      rows: toCamelRows(rows.map((r) => stripTotal(r as Record<string, unknown>))),
      pagination: { page, pageSize, total },
    };
  })
);

// ---------------------------------------------------------------------------
// Document detail
// ---------------------------------------------------------------------------
documentsOpsRouter.get(
  '/settings',
  ...runGet('documents.settings.manage', async (c, ctx) => {
    if (!ctx.companyId) throw badRequest('Company context is required');
    const { rows } = await c.query(
      `SELECT * FROM dms_settings
        WHERE tenant_id = $1 AND company_id = $2 ORDER BY category, key`,
      [ctx.tenantId ?? 0, ctx.companyId]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

documentsOpsRouter.get(
  '/:id',
  ...runGet('documents.view', async (c, ctx, _q, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const id = Number(p.id);
    const { rows } = await c.query(
      `SELECT d.*, f.name AS folder_name, f.code AS folder_code,
              (o.first_name || ' ' || o.last_name) AS owner_name,
              (cb.first_name || ' ' || cb.last_name) AS created_by_name,
              (ub.first_name || ' ' || ub.last_name) AS updated_by_name
         FROM dms_documents d
         LEFT JOIN dms_folders f ON f.id = d.folder_id
         LEFT JOIN users o ON o.id = d.owner_id
         LEFT JOIN users cb ON cb.id = d.created_by
         LEFT JOIN users ub ON ub.id = d.updated_by
        WHERE d.id = $1 AND d.tenant_id = $2 AND d.deleted_at IS NULL`,
      [id, tenantId]
    );
    if (!rows.length) throw notFound('Document not found');
    const versions = await c.query(
      `SELECT v.*, (u.first_name || ' ' || u.last_name) AS uploaded_by_name
         FROM dms_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.document_id = $1 AND v.tenant_id = $2 ORDER BY v.version DESC`,
      [id, tenantId]
    );
    const reviews = await c.query(
      `SELECT r.*, (u.first_name || ' ' || u.last_name) AS reviewer_name
         FROM dms_reviews r LEFT JOIN users u ON u.id = r.reviewer_id
        WHERE r.document_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at DESC`,
      [id, tenantId]
    );
    return {
      document: toCamelRow(rows[0] as Record<string, unknown>),
      versions: toCamelRows(versions.rows as Record<string, unknown>[]),
      reviews: toCamelRows(reviews.rows as Record<string, unknown>[]),
    };
  })
);

// ---------------------------------------------------------------------------
// Create metadata (no file)
// ---------------------------------------------------------------------------
documentsOpsRouter.post(
  '/',
  ...run('documents.create', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const title = String(b.title ?? '').trim();
    if (!title) throw badRequest('Document title is required');
    const tags = Array.isArray(b.tags) ? b.tags.map(String) : [];
    const { rows } = await c.query(
      `INSERT INTO dms_documents
         (tenant_id, company_id, branch_id, folder_id, title, description, category, classification,
          status, entity_type, entity_id, owner_id, tags, retention_until, is_template, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        tenantId,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        num(b.folderId),
        title,
        str(b.description),
        validCategory(b.category),
        validClassification(b.classification),
        validStatus(b.status, 'DRAFT'),
        str(b.entityType),
        num(b.entityId),
        num(b.ownerId) ?? ctx.userId,
        JSON.stringify(tags),
        str(b.retentionUntil),
        bool(b.isTemplate),
        ctx.userId ?? null,
        ctx.userId ?? null,
      ]
    );
    const doc = rows[0];
    await logAudit(c, ctx, {
      action: 'DMS_DOCUMENT_CREATED', resource: 'dms_document', recordId: Number(doc.id), recordCode: String(doc.code),
      metadata: { title },
    });
    return toCamelRow(doc as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Update metadata + status transitions
// ---------------------------------------------------------------------------
const TRANSITIONS: Record<string, string[]> = {
  SUBMITTED: ['DRAFT', 'IN_REVIEW'],
  APPROVED: ['IN_REVIEW', 'APPROVED'],
  REJECTED: ['IN_REVIEW', 'DRAFT'],
  REQUEST_CHANGES: ['IN_REVIEW', 'DRAFT'],
  RELEASED: ['APPROVED', 'IN_REVIEW', 'RELEASED'],
  ARCHIVED: STATUSES,
  OBSOLETE: STATUSES,
  RESTORED: ['ARCHIVED', 'OBSOLETE'],
};

documentsOpsRouter.patch(
  '/:id',
  ...run('documents.edit', async (c, ctx, b, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const id = Number(p.id);
    const { rows: cur } = await c.query(
      `SELECT * FROM dms_documents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    );
    if (!cur.length) throw notFound('Document not found');
    const doc = cur[0];
    const tags = Array.isArray(b.tags) ? b.tags.map(String) : undefined;
    const { rows } = await c.query(
      `UPDATE dms_documents SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         category = COALESCE($5, category),
         classification = COALESCE($6, classification),
         folder_id = COALESCE($7, folder_id),
         owner_id = COALESCE($8, owner_id),
         entity_type = COALESCE($9, entity_type),
         entity_id = COALESCE($10, entity_id),
         retention_until = COALESCE($11, retention_until),
         is_template = COALESCE($12, is_template),
         tags = COALESCE($13, tags),
         updated_by = $14,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [
        id,
        tenantId,
        str(b.title),
        b.description !== undefined ? String(b.description) : null,
        b.category ? validCategory(b.category) : null,
        b.classification ? validClassification(b.classification) : null,
        b.folderId !== undefined ? num(b.folderId) : null,
        b.ownerId !== undefined ? num(b.ownerId) : null,
        b.entityType !== undefined ? str(b.entityType) : null,
        b.entityId !== undefined ? num(b.entityId) : null,
        b.retentionUntil !== undefined ? str(b.retentionUntil) : null,
        b.isTemplate !== undefined ? bool(b.isTemplate) : null,
        tags !== undefined ? JSON.stringify(tags) : null,
        ctx.userId ?? null,
      ]
    );
    const updated = rows[0];
    let reviewAction: string | null = null;
    if (b.status && String(b.status).toUpperCase() !== String(doc.status).toUpperCase()) {
      const to = validStatus(b.status);
      const from = String(doc.status).toUpperCase();
      if (TRANSITIONS[to] && !TRANSITIONS[to].includes(from)) {
        throw badRequest(`Invalid status transition ${from} -> ${to}`);
      }
      reviewAction = to === 'RELEASED' ? 'RELEASED' : to === 'APPROVED' ? 'APPROVED' : to === 'IN_REVIEW' ? 'SUBMITTED' : to;
      await c.query(
        `UPDATE dms_documents SET status = $1, updated_by = $2, updated_at = now()
          WHERE id = $3 AND tenant_id = $4`,
        [to, ctx.userId ?? null, id, tenantId]
      );
      await c.query(
        `INSERT INTO dms_reviews (tenant_id, document_id, version_id, reviewer_id, action, comment)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          tenantId,
          id,
          doc.version != null && Number(doc.version) > 0 ? null : null,
          ctx.userId ?? null,
          reviewAction,
          str(b.comment),
        ]
      );
    }
    const finalRow = (await c.query(
      `SELECT * FROM dms_documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    )).rows[0];
    await logAudit(c, ctx, {
      action: reviewAction ? `DMS_DOCUMENT_${reviewAction}` : 'DMS_DOCUMENT_UPDATED',
      resource: 'dms_document', recordId: id, recordCode: String(doc.code),
      metadata: { title: String(updated.title) },
    });
    return toCamelRow(finalRow as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------
documentsOpsRouter.delete(
  '/:id',
  ...run('documents.delete', async (c, ctx, _b, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE dms_documents SET deleted_at = now(), updated_by = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING code`,
      [id, tenantId, ctx.userId ?? null]
    );
    if (!rows.length) throw notFound('Document not found');
    await logAudit(c, ctx, {
      action: 'DMS_DOCUMENT_DELETED', resource: 'dms_document', recordId: id, recordCode: String(rows[0].code),
    });
    return { ok: true };
  })
);

// ---------------------------------------------------------------------------
// File upload (creates a new version)
// ---------------------------------------------------------------------------
documentsOpsRouter.post(
  '/:id/upload',
  requirePermission('documents.upload'),
  docUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A file is required (field "file")');
    const out = await tx(
      (client) => uploadDocumentFile(client, req.ctx, {
        documentId: Number(req.params.id),
        file: {
          originalname: req.file!.originalname,
          mimetype: req.file!.mimetype,
          size: req.file!.size,
          buffer: req.file!.buffer,
        },
        changeNote: req.body.changeNote != null ? String(req.body.changeNote) : null,
        title: req.body.title != null ? String(req.body.title) : null,
      }),
      req.ctx
    );
    res.status(201).json({ data: out });
  })
);

async function uploadDocumentFile(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    documentId: number;
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
    changeNote?: string | null;
    title?: string | null;
  }
): Promise<Record<string, unknown>> {
  const tenantId = ctx.tenantId ?? 0;
  const { rows: cur } = await client.query(
    `SELECT * FROM dms_documents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [input.documentId, tenantId]
  );
  if (!cur.length) throw notFound('Document not found');
  const doc = cur[0];
  const nextVersion = Number(doc.version ?? 0) + 1;
  const rel = storageRel(ctx, input.documentId, nextVersion, input.file.originalname);
  const abs = path.join(config.storageRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const hash = createHash('sha256').update(input.file.buffer).digest('hex');
  writeFileSync(abs, input.file.buffer);
  const { rows: vrows } = await client.query(
    `INSERT INTO dms_versions
       (tenant_id, document_id, version, file_name, file_type, file_size, storage_path, content_hash, change_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      tenantId,
      input.documentId,
      nextVersion,
      safeFileName(input.file.originalname),
      input.file.mimetype,
      input.file.size,
      rel,
      hash,
      input.changeNote,
      ctx.userId ?? null,
    ]
  );
  const { rows } = await client.query(
    `UPDATE dms_documents SET
       version = $3, file_name = $4, file_type = $5, file_size = $6, storage_path = $7,
       content_hash = $8,
       title = COALESCE($9, title),
       updated_by = $10, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      input.documentId,
      tenantId,
      nextVersion,
      safeFileName(input.file.originalname),
      input.file.mimetype,
      input.file.size,
      rel,
      hash,
      input.title,
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'DMS_FILE_UPLOADED', resource: 'dms_document', recordId: input.documentId,
    recordCode: String(doc.code), metadata: { version: nextVersion, size: input.file.size, hash: hash.slice(0, 12) },
  });
  return {
    document: toCamelRow(rows[0] as Record<string, unknown>),
    version: toCamelRow(vrows[0] as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Review / workflow action
// ---------------------------------------------------------------------------
documentsOpsRouter.post(
  '/:id/review',
  ...run('documents.approve', async (c, ctx, b, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const id = Number(p.id);
    const action = String(b.action ?? '').toUpperCase();
    if (!Object.keys(TRANSITIONS).includes(action)) {
      throw badRequest('Invalid review action');
    }
    const { rows: cur } = await c.query(
      `SELECT * FROM dms_documents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    );
    if (!cur.length) throw notFound('Document not found');
    const doc = cur[0];
    const from = String(doc.status).toUpperCase();
    const to =
      action === 'SUBMITTED' ? 'IN_REVIEW' :
      action === 'APPROVED' ? 'APPROVED' :
      action === 'REJECTED' || action === 'REQUEST_CHANGES' ? 'DRAFT' :
      action === 'RELEASED' ? 'RELEASED' :
      action === 'RESTORED' ? 'RELEASED' :
      action;
    if (TRANSITIONS[action] && !TRANSITIONS[action].includes(from)) {
      throw badRequest(`Cannot ${action} a document in ${from} status`);
    }
    const versionId = doc.version != null && Number(doc.version) > 0
      ? (await c.query(
          `SELECT id FROM dms_versions WHERE document_id = $1 AND version = $2`,
          [id, Number(doc.version)]
        )).rows[0]?.id ?? null
      : null;
    await c.query(
      `INSERT INTO dms_reviews (tenant_id, document_id, version_id, reviewer_id, action, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, id, versionId, ctx.userId ?? null, action, str(b.comment)]
    );
    const { rows } = await c.query(
      `UPDATE dms_documents SET status = $3, updated_by = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, to, ctx.userId ?? null]
    );
    await logAudit(c, ctx, {
      action: `DMS_REVIEW_${action}`, resource: 'dms_document', recordId: id, recordCode: String(doc.code),
      metadata: { from, to, comment: str(b.comment) },
    });
    if (action === 'APPROVED' || action === 'RELEASED' || action === 'REJECTED' || action === 'REQUEST_CHANGES') {
      const ownerId = doc.owner_id ? Number(doc.owner_id) : null;
      const recipients = [ownerId, doc.created_by ? Number(doc.created_by) : null]
        .filter((n): n is number => n != null && Number.isFinite(n) && n !== (ctx.userId ?? 0));
      if (recipients.length > 0) {
        await notifyUsers(c, ctx, {
          userIds: recipients,
          type: 'DOCUMENT_REVIEW',
          title: `Document ${action === 'REJECTED' ? 'rejected' : action === 'REQUEST_CHANGES' ? 'changes requested on' : action === 'APPROVED' ? 'approved' : 'released'}: ${String(doc.code)}`,
          body: String(doc.title ?? ''),
          link: '/#/documents/library/' + id,
          actionLabel: 'View document',
          actionTarget: '/#/documents/library/' + id,
          entityType: 'dms_document',
          entityId: id,
          priority: action === 'REJECTED' || action === 'REQUEST_CHANGES' ? 'HIGH' : 'NORMAL',
        }, recipients);
      }
    }
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Download file
// ---------------------------------------------------------------------------
documentsOpsRouter.get(
  '/:id/file',
  requirePermission('documents.download'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId ?? 0;
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT code, title, file_name, file_type, file_size, storage_path
         FROM dms_documents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    );
    const doc = rows[0];
    if (!doc) throw notFound('Document not found');
    const rel = String(doc.storage_path ?? '').trim();
    if (!rel || rel.includes('..')) throw notFound('No file has been uploaded for this document');
    const abs = path.join(config.storageRoot, rel);
    if (!existsSync(abs)) throw notFound('File not found on storage');
    const bytes = readFileSync(abs);
    const safe = safeFileName(String(doc.file_name ?? 'document.bin'));
    const disposition = String(req.query.download ?? '') === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', String(doc.file_type ?? 'application/octet-stream'));
    res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"`);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  })
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

documentsOpsRouter.put(
  '/settings',
  ...run('documents.settings.manage', async (c, ctx, b) => {
    if (!ctx.companyId) throw badRequest('Company context is required');
    const tenantId = ctx.tenantId ?? 0;
    const items = Array.isArray(b.items) ? b.items : [b];
    const saved: Record<string, unknown>[] = [];
    for (const item of items) {
      const category = String(item.category ?? 'GENERAL');
      const key = String(item.key ?? '');
      if (!key) throw badRequest('settings key is required');
      const { rows } = await c.query(
        `INSERT INTO dms_settings (tenant_id, company_id, category, key, value, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, company_id, category, key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [tenantId, ctx.companyId, category, key, JSON.stringify(item.value ?? {}), ctx.userId ?? null]
      );
      saved.push(toCamelRow(rows[0] as Record<string, unknown>));
    }
    await logAudit(c, ctx, {
      action: 'DMS_SETTINGS_UPDATED', resource: 'dms_settings', recordId: null,
      metadata: { keys: saved.map((s) => s.key as string) },
    });
    return saved;
  })
);
