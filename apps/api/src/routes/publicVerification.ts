import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db.js';
import { verifyQrPublic } from '../services/qr.js';
import { verifyEmployeePublic } from '../services/employeeIdentity.js';
import { verifyContractDocument } from '../services/contracts.js';
import { DOCUMENT_TYPES } from '../services/documents.js';
import { documentFingerprint, loadCompanyProfile, toPublicCompany, verifyDocumentToken } from '../services/branding.js';
import type { PublicCompanyInfo } from '../services/branding.js';
import { asyncHandler, badRequest } from '../utils.js';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../config.js';

const LOGO_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const LOGO_EXTS = Object.keys(LOGO_MIME_BY_EXT);

/**
 * Public, unauthenticated verification portal.
 * - POST /verify            -> product QR authenticity (verify_qr_public)
 * - POST /verify-document   -> tamper-evident check for exported business documents
 * Only safe identity/authenticity information is ever returned; no business data leaks.
 */
export const publicVerificationRouter = Router();

publicVerificationRouter.get(
  '/branding/logo',
  asyncHandler(async (req, res) => {
    const tenant = String(req.query.tenant ?? '0');
    const company = String(req.query.company ?? '0');
    if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company)) throw badRequest('Invalid tenant or company');
    const dir = path.join(config.storageRoot, 'branding', tenant, company);
    for (const ext of LOGO_EXTS) {
      const filePath = path.join(dir, `logo${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', LOGO_MIME_BY_EXT[ext]);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(readFileSync(filePath));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Logo not found' } });
  })
);

const FAVICON_MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const FAVICON_EXTS = Object.keys(FAVICON_MIME_BY_EXT);

publicVerificationRouter.get(
  '/branding/favicon',
  asyncHandler(async (req, res) => {
    const tenant = String(req.query.tenant ?? '0');
    const company = String(req.query.company ?? '0');
    if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company)) throw badRequest('Invalid tenant or company');
    const dir = path.join(config.storageRoot, 'branding', tenant, company);
    for (const ext of FAVICON_EXTS) {
      const filePath = path.join(dir, `favicon${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', FAVICON_MIME_BY_EXT[ext]);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(readFileSync(filePath));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Favicon not found' } });
  })
);

const SIGNATURE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const SIGNATURE_EXTS = Object.keys(SIGNATURE_MIME_BY_EXT);

publicVerificationRouter.get(
  '/branding/signature',
  asyncHandler(async (req, res) => {
    const tenant = String(req.query.tenant ?? '0');
    const company = String(req.query.company ?? '0');
    if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company)) throw badRequest('Invalid tenant or company');
    const dir = path.join(config.storageRoot, 'branding', tenant, company);
    for (const ext of SIGNATURE_EXTS) {
      const filePath = path.join(dir, `signature${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', SIGNATURE_MIME_BY_EXT[ext]);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(readFileSync(filePath));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signature not found' } });
  })
);

const FOOTER_LOGO_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const FOOTER_LOGO_EXTS = Object.keys(FOOTER_LOGO_MIME_BY_EXT);

publicVerificationRouter.get(
  '/branding/footer-logo',
  asyncHandler(async (req, res) => {
    const tenant = String(req.query.tenant ?? '0');
    const company = String(req.query.company ?? '0');
    if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company)) throw badRequest('Invalid tenant or company');
    const dir = path.join(config.storageRoot, 'branding', tenant, company);
    for (const ext of FOOTER_LOGO_EXTS) {
      const filePath = path.join(dir, `footer-logo${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', FOOTER_LOGO_MIME_BY_EXT[ext]);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(readFileSync(filePath));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Footer logo not found' } });
  })
);

/** Per-signatory uploaded contract signature: branding/<tenant>/<company>/contract-sig-<contract>-<signer><ext>. */
publicVerificationRouter.get(
  '/branding/contract-signature',
  asyncHandler(async (req, res) => {
    const tenant = String(req.query.tenant ?? '0');
    const company = String(req.query.company ?? '0');
    const contract = String(req.query.contract ?? '');
    const signer = String(req.query.signer ?? '');
    if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company) || !/^\d+$/.test(contract)) throw badRequest('Invalid tenant, company or contract');
    if (!/^[A-Z_]+$/.test(signer)) throw badRequest('Invalid signer');
    const dir = path.join(config.storageRoot, 'branding', tenant, company);
    for (const ext of SIGNATURE_EXTS) {
      const filePath = path.join(dir, `contract-sig-${contract}-${signer}${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', SIGNATURE_MIME_BY_EXT[ext]);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(readFileSync(filePath));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contract signature not found' } });
  })
);

/**
 * Public, read-only company branding profile for login screens, portals and
 * verification pages. Mirrors the branding image routes: accepts optional
 * tenant/company/branch query params, falls back to the authenticated context
 * (when present) or to the first tenant for single-tenant deployments.
 */
publicVerificationRouter.get(
  '/company',
  asyncHandler(async (req, res) => {
    const tenantParam = String(req.query.tenant ?? req.ctx.tenantId ?? '');
    const companyParam = String(req.query.company ?? req.ctx.companyId ?? '');
    const branchParam = String(req.query.branch ?? req.ctx.branchId ?? '');
    if (tenantParam && !/^\d+$/.test(tenantParam)) throw badRequest('Invalid tenant');
    if (companyParam && !/^\d+$/.test(companyParam)) throw badRequest('Invalid company');
    if (branchParam && !/^\d+$/.test(branchParam)) throw badRequest('Invalid branch');

    const tenantId = tenantParam
      ? Number(tenantParam)
      : Number((await query<{ id: string }>('SELECT id FROM tenants ORDER BY id ASC LIMIT 1')).rows[0]?.id) || 0;
    const companyId = companyParam ? Number(companyParam) : null;
    const branchId = branchParam ? Number(branchParam) : null;

    const profile = await tx(
      async (client) => {
        let resolvedBranch = branchId;
        if (!resolvedBranch) {
          const br = await client.query<{ id: string }>(
            `SELECT b.id FROM branches b
             WHERE b.tenant_id = $1 AND ($2::bigint IS NULL OR b.company_id = $2)
             ORDER BY b.id ASC LIMIT 1`,
            [tenantId, companyId]
          );
          resolvedBranch = br.rows[0]?.id ? Number(br.rows[0].id) : null;
        }
        return toPublicCompany(
          await loadCompanyProfile(client, { tenantId, companyId, branchId: resolvedBranch })
        );
      },
      { tenantId, companyId, branchId }
    );
    res.json({ data: profile });
  })
);

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many verification requests. Try again later.' },
});

const docVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many document verification requests. Try again later.' },
});

publicVerificationRouter.post(
  '/verify',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    const payload = String(req.body?.payload ?? '').trim();
    if (!payload) throw badRequest('payload is required');
    const result = await verifyQrPublic(payload, req.ctx.ip, req.ctx.userAgent, req.ctx.device);
    res.json({ data: result });
  })
);

const contractVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many contract verification requests. Try again later.' },
});

publicVerificationRouter.post(
  '/verify-contract',
  contractVerifyLimiter,
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code ?? '').trim();
    const secret = String(req.body?.secret ?? '').trim();
    if (!code || !secret) throw badRequest('Verification code and secret are required');
    const result = await tx(
      async (client) => verifyContractDocument(client, req.ctx, { code, secret }),
      req.ctx
    );
    res.json({ data: result });
  })
);

publicVerificationRouter.post(
  '/verify-document',
  docVerifyLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    if (!token) throw badRequest('token is required');

    const claims = verifyDocumentToken(token);
    if (!claims) {
      res.json({ data: { valid: false, tampered: true, reason: 'INVALID_TOKEN', title: null } });
      return;
    }
    const def = DOCUMENT_TYPES[claims.type];
    if (!def) {
      res.json({ data: { valid: false, tampered: true, reason: 'UNKNOWN_TYPE', title: null } });
      return;
    }

    // Re-load the canonical content under the tenant/company-scoped context (RLS applies)
    // and recompute the fingerprint to detect tampering or deletion since issuance.
    const ctx = { tenantId: claims.tenantId, companyId: claims.companyId };
    let current: { fingerprint: string; code: string; title: string; company: PublicCompanyInfo };
    try {
      current = await tx(
        async (client) => {
          const loaded = await def.load(client, ctx, claims.id);
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
          const company = toPublicCompany(await loadCompanyProfile(client, ctx));
          return { fingerprint: fp, code: loaded.code, title: loaded.title, company };
        },
        ctx
      );
    } catch (err) {
      res.json({ data: { valid: false, tampered: true, reason: 'NOT_FOUND_OR_CHANGED', title: claims.title } });
      return;
    }

    const matches = current.fingerprint === claims.fingerprint;
    res.json({
      data: {
        valid: matches,
        tampered: !matches,
        fingerprint: current.fingerprint,
        code: current.code,
        title: current.title,
        issuedAt: claims.issuedAt,
        issuer: claims.issuerName || claims.issuer,
        companyName: claims.companyName,
        company: current.company,
      },
    });
  })
);

const employeeVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many employee verification requests. Try again later.' },
});

publicVerificationRouter.post(
  '/verify-employee',
  employeeVerifyLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    if (!token) throw badRequest('token is required');
    const result = await verifyEmployeePublic(token, req.ctx.ip, req.ctx.userAgent, req.ctx.device);
    res.json({ data: result });
  })
);
