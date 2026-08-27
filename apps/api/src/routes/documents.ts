import { Router } from 'express';
import { tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { logAudit } from '../services/audit.js';
import { DOCUMENT_TYPES, renderDocument } from '../services/documents.js';
import {
  documentFingerprint,
  documentVerifyUrl,
  issueDocumentToken,
  loadCompanyProfile,
} from '../services/branding.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';

export const documentsRouter = Router();

const FORMATS = ['pdf', 'xlsx', 'csv', 'json', 'print'];

documentsRouter.get(
  '/:type/:id',
  (req, res, next) => {
    const def = DOCUMENT_TYPES[req.params.type];
    if (!def) return next(notFound('Unknown document type'));
    return requirePermission(def.permission)(req, res, next);
  },
  asyncHandler(async (req, res) => {
    const def = DOCUMENT_TYPES[req.params.type];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid document id');
    const format = String(req.query.format ?? 'pdf').toLowerCase();
    if (!FORMATS.includes(format)) throw badRequest(`Unsupported format: ${format}`);

    const { data, profile, fingerprint, token, verifyUrl, issuedAt, issuerName } = await tx(
      async (client) => {
        const loaded = await def.load(client, req.ctx, id);
        await logAudit(client, req.ctx, {
          action: 'export',
          resource: def.type,
          recordId: id,
          recordCode: loaded.code,
          metadata: { format, label: def.label },
        });

        const company = await loadCompanyProfile(client, req.ctx);
        const issued = new Date().toISOString();
        const fp = documentFingerprint({
          code: loaded.code,
          title: loaded.title,
          subtitle: loaded.subtitle,
          meta: loaded.meta,
          columns: loaded.columns,
          items: loaded.items,
          totals: loaded.totals,
          notes: loaded.notes,
        });
        const email = req.auth?.email ?? 'unknown';
        const name = [req.auth?.first_name, req.auth?.last_name].filter(Boolean).join(' ') || email;
        const tok = company.verifyEnabled
          ? issueDocumentToken({
              type: def.type,
              id,
              code: loaded.code,
              title: loaded.title,
              fingerprint: fp,
              issuedAt: issued,
              tenantId: req.ctx.tenantId ?? 0,
              companyId: req.ctx.companyId ?? null,
              companyName: company.name,
              issuer: email,
              issuerName: name,
            })
          : '';

        return {
          data: loaded,
          profile: company,
          fingerprint: fp,
          token: tok,
          verifyUrl: tok ? documentVerifyUrl(company, tok) : '',
          issuedAt: issued,
          issuerName: name,
        };
      },
      req.ctx
    );

    const { buffer, contentType, extension } = await renderDocument(format, data, {
      company: profile,
      issuedBy: issuerName,
      issuedAt,
      signerName: issuerName,
      signerRole: req.auth?.job_title ?? undefined,
      correlationId: req.ctx.correlationId ?? null,
      fingerprint,
      token: token || undefined,
      verifyUrl: verifyUrl || undefined,
    });
    const safe = String(data.code || `${def.type}-${id}`).replace(/[^A-Za-z0-9._-]+/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'print') {
      res.setHeader('Content-Disposition', `inline; filename="${def.type}_${safe}.${extension}"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${def.type}_${safe}.${extension}"`);
    }
    res.send(buffer);
  })
);
