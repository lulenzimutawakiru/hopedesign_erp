import { Router } from 'express';
import pg from 'pg';
import { query, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, badRequest } from '../utils.js';
import { logAudit } from '../services/audit.js';
import multer from 'multer';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const settingsRouter = Router();

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const LOGO_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const LOGO_EXTS = ['.png', '.jpg', '.webp'];

function logoStorageKey(tenantId: number | null | undefined, companyId: number | null | undefined, ext: string) {
  return path.join('branding', String(tenantId ?? 0), String(companyId ?? 0), `logo${ext}`);
}

/** Reject files whose magic bytes do not match the declared image type. */
function assertImageMagic(buf: Buffer, ext: string) {
  const hex = buf.subarray(0, 16).toString('hex');
  const ok =
    (ext === '.png' && hex.startsWith('89504e47')) ||
    (ext === '.jpg' && hex.startsWith('ffd8ff')) ||
    (ext === '.webp' && hex.startsWith('52494646') && hex.slice(8, 16) === '57454250') ||
    (ext === '.ico' && hex.startsWith('00000100'));
  if (!ok) throw badRequest('File content does not match the declared image type');
}
const faviconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const FAVICON_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

const FAVICON_EXTS = ['.png', '.ico'];

function faviconStorageKey(tenantId: number | null | undefined, companyId: number | null | undefined, ext: string) {
  return path.join('branding', String(tenantId ?? 0), String(companyId ?? 0), `favicon${ext}`);
}

const signatureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SIGNATURE_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const SIGNATURE_EXTS = ['.png', '.jpg'];

function signatureStorageKey(tenantId: number | null | undefined, companyId: number | null | undefined, ext: string) {
  return path.join('branding', String(tenantId ?? 0), String(companyId ?? 0), `signature${ext}`);
}

const footerLogoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const FOOTER_LOGO_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const FOOTER_LOGO_EXTS = ['.png', '.jpg'];

function footerLogoStorageKey(tenantId: number | null | undefined, companyId: number | null | undefined, ext: string) {
  return path.join('branding', String(tenantId ?? 0), String(companyId ?? 0), `footer-logo${ext}`);
}

export type SettingType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'color' | 'url' | 'tel';

export interface SettingDef {
  label: string;
  help?: string;
  type: SettingType;
  options?: string[];
  secret?: boolean;
  group?: string;
  default?: string | number | boolean;
}

export const SETTING_CATEGORIES: { id: string; label: string; blurb: string }[] = [
  { id: 'general', label: 'General', blurb: 'Company identity, contact, localisation, tax and operational defaults.' },
  { id: 'security', label: 'Security', blurb: 'Password rules, session length and account lockout.' },
  { id: 'notifications', label: 'Notifications', blurb: 'Email, SMS and alert preferences.' },
  { id: 'qr', label: 'QR & Traceability', blurb: 'Code prefixes, serial formats and verification.' },
  { id: 'quality', label: 'Quality', blurb: 'Inspection, QC blocking and rework rules.' },
  { id: 'documents', label: 'Documents', blurb: 'Retention, archiving and export branding.' },
];

export const SETTINGS: Record<string, Record<string, SettingDef>> = {
  general: {
    company_name: { label: 'Company name', help: 'Trading name shown on documents, labels and reports.', type: 'text', group: 'Company identity' },
    company_legal_name: { label: 'Legal / registered name', help: 'Full registered legal name used on invoices and statutory documents.', type: 'text', group: 'Company identity' },
    company_tagline: { label: 'Company tagline', type: 'text', group: 'Company identity' },
    industry: { label: 'Industry', help: 'Primary industry used for report grouping and compliance defaults.', type: 'select', options: ['Manufacturing', 'Paper & Packaging', 'Security Printing', 'FMCG', 'Pharmaceuticals', 'Agriculture', 'Logistics', 'Retail', 'Other'], default: 'Manufacturing', group: 'Company identity' },
    website: { label: 'Website', help: 'Public company website, linked from branded exports.', type: 'url', group: 'Company identity' },
    logo_url: { label: 'Logo URL', help: 'Public URL of the company logo used in branded document exports.', type: 'url', group: 'Company identity' },
    favicon_url: { label: 'Favicon URL', help: 'Public URL of the browser tab icon (PNG or ICO).', type: 'url', group: 'Company identity' },
    signature_url: { label: 'Signature image URL', help: 'Public URL of the uploaded signature image used on auto-signed documents.', type: 'url', group: 'Company identity' },
    footer_logo_url: { label: 'Footer logo URL', help: 'Public URL of the separate footer logo shown at the bottom of branded documents and exports.', type: 'url', group: 'Company identity' },
    brand_color: { label: 'Primary brand colour', help: 'Accent colour used on branded documents and exports.', type: 'color', default: '#1261A0', group: 'Company identity' },
    brand_color_secondary: { label: 'Secondary brand colour', help: 'Secondary accent for highlights and supporting elements.', type: 'color', default: '#00A6A6', group: 'Company identity' },

    contact_email: { label: 'Primary contact email', help: 'Used as the reply-to on generated notifications.', type: 'text', default: '', group: 'Contact & location' },
    support_email: { label: 'Support email', help: 'Shown on reports and public verification pages for customer queries.', type: 'text', group: 'Contact & location' },
    contact_phone: { label: 'Contact phone', help: 'Main switchboard or reception number.', type: 'tel', group: 'Contact & location' },
    physical_address: { label: 'Physical address', help: 'Registered office address shown on invoices and exported documents.', type: 'textarea', group: 'Contact & location' },
    city: { label: 'City', type: 'text', group: 'Contact & location' },
    country: { label: 'Country', type: 'select', options: ['Uganda', 'Kenya', 'Tanzania', 'Rwanda', 'South Sudan', 'Nigeria', 'Ghana', 'South Africa', 'Other'], default: 'Uganda', group: 'Contact & location' },

    currency: { label: 'Default currency', type: 'select', options: ['UGX', 'USD', 'EUR', 'GBP', 'KES', 'TZS'], default: 'UGX', group: 'Localisation' },
    currency_symbol: { label: 'Currency symbol', help: 'Short symbol shown next to amounts (e.g. UGX, USh or $).', type: 'text', default: 'UGX', group: 'Localisation' },
    language: { label: 'Interface language', type: 'select', options: ['en', 'sw', 'fr'], default: 'en', group: 'Localisation' },
    date_format: { label: 'Date format', help: 'How dates appear across documents and exports.', type: 'select', options: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'], default: 'YYYY-MM-DD', group: 'Localisation' },
    timezone: { label: 'Timezone', type: 'select', options: ['Africa/Kampala', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Accra', 'Africa/Johannesburg', 'Africa/Cairo', 'UTC', 'Europe/London', 'Asia/Dubai'], default: 'Africa/Kampala', group: 'Localisation' },
    number_format: { label: 'Number format', help: 'How thousands and decimals are displayed on reports and exports.', type: 'select', options: ['1,234.56', '1 234,56', '1.234,56'], default: '1,234.56', group: 'Localisation' },
    week_starts_on: { label: 'Week starts on', help: 'First day of the week for calendars and scheduling.', type: 'select', options: ['Monday', 'Sunday'], default: 'Monday', group: 'Localisation' },

    tax_id: { label: 'Tax / VAT registration number', help: 'TIN or VAT number printed on invoices and tax reports.', type: 'text', group: 'Tax & fiscal' },
    default_tax_rate: { label: 'Default tax rate (%)', help: 'Rate applied to new sales and purchase lines when no tax code is chosen.', type: 'number', default: 18, group: 'Tax & fiscal' },
    fiscal_year_start: { label: 'Fiscal year start month', help: 'Month (1-12) the fiscal year begins.', type: 'number', default: 7, group: 'Tax & fiscal' },

    bank_name: { label: 'Bank name', help: 'Default bank shown on sales orders and invoices. Can be overridden per document.', type: 'text', default: '', group: 'Bank details' },
    bank_account_name: { label: 'Bank account name', help: 'Account holder name printed on sales orders and invoices.', type: 'text', default: '', group: 'Bank details' },
    bank_account_number: { label: 'Bank account number', help: 'Account number printed on sales orders and invoices.', type: 'text', default: '', group: 'Bank details' },

    low_stock_threshold: { label: 'Low stock threshold', help: 'Alert when an item drops to this stock level.', type: 'number', default: 5, group: 'Operations' },
    default_reorder_qty: { label: 'Default reorder quantity', help: 'Suggested quantity when creating replenishment orders.', type: 'number', default: 0, group: 'Operations' },
    default_lead_time_days: { label: 'Default supplier lead time (days)', help: 'Used to calculate expected delivery dates for purchase orders.', type: 'number', default: 14, group: 'Operations' },
    batch_tracking_enabled: { label: 'Batch / lot tracking', help: 'Track inventory by batch or lot number.', type: 'boolean', default: true, group: 'Operations' },
    serial_tracking_enabled: { label: 'Serial number tracking', help: 'Track individual units by serial number.', type: 'boolean', default: false, group: 'Operations' },
    expiry_tracking_enabled: { label: 'Expiry tracking', help: 'Track expiry dates on inventory lots and alert before expiry.', type: 'boolean', default: true, group: 'Operations' },
  },
  security: {
    password_min_length: { label: 'Minimum password length', type: 'number', default: 8 },
    password_require_special: { label: 'Require special characters in passwords', type: 'boolean', default: true },
    password_max_age_days: { label: 'Password expiry (days)', help: 'Force a password change after this many days (0 = never).', type: 'number', default: 90 },
    password_history_count: { label: 'Password history kept', help: 'Reuse is blocked within this many previous passwords.', type: 'number', default: 5 },
    session_timeout_minutes: { label: 'Session timeout (minutes)', type: 'number', default: 30 },
    login_lockout_attempts: { label: 'Lockout after failed logins', type: 'number', default: 5 },
    mfa_required: { label: 'Require MFA for administrators', type: 'boolean', default: false },
  },
  notifications: {
    email_enabled: { label: 'Email notifications', type: 'boolean', default: true },
    sms_enabled: { label: 'SMS notifications', type: 'boolean', default: false },
    low_stock_alerts: { label: 'Low stock alerts', type: 'boolean', default: true },
    approval_reminders: { label: 'Approval reminders', type: 'boolean', default: true },
    anomaly_alerts: { label: 'QR anomaly alerts', type: 'boolean', default: true },
    digest: { label: 'Digest frequency', type: 'select', options: ['none', 'daily', 'weekly'], default: 'daily' },
  },
  qr: {
    qr_prefix: { label: 'QR code prefix', help: 'Leading letters on generated codes (e.g. HDG).', type: 'text', default: 'HDG' },
    qr_verify_url: { label: 'Public verification URL', type: 'text', default: 'https://hopedesign.jorlentech.com/verify' },
    qr_serial_length: { label: 'Serial number length', help: 'Digits after the prefix/date on generated codes.', type: 'number', default: 8 },
    qr_expiry_days: { label: 'Code expiry (days)', help: '0 = codes never expire.', type: 'number', default: 0 },
    qr_auto_suspend_on_anomaly: { label: 'Auto-suspend codes on anomaly', type: 'boolean', default: true },
  },
  quality: {
    qc_auto_block_on_fail: { label: 'Auto-block stock on failed QC', type: 'boolean', default: true },
    inspection_default: { label: 'Default inspection mode', type: 'select', options: ['sample', 'full'], default: 'sample' },
    inspection_due_warning_days: { label: 'Inspection due warning (days)', help: 'Warn this far ahead of an inspection due date.', type: 'number', default: 3 },
    rework_approval_required: { label: 'Rework requires approval', type: 'boolean', default: false },
  },
  documents: {
    retention_days: { label: 'Document retention (days)', type: 'number', default: 1825 },
    auto_archive: { label: 'Auto-archive expired documents', type: 'boolean', default: true },
    pdf_stamp: { label: 'Stamp printed documents', help: 'Adds user, time and correlation details to printed documents.', type: 'boolean', default: false },
    brand_enabled: { label: 'Branded document exports', help: 'Adds the company brand, logo and full contact details to every exported document.', type: 'boolean', default: true },
    verify_enabled: { label: 'Tamper-evident verification on exports', help: 'Adds signed tokens, SHA-256 fingerprints and QR verification links to exported documents.', type: 'boolean', default: true },
    footer_text: { label: 'Document footer text', help: 'Extra text shown in the footer of exported documents.', type: 'text' },
    archive_format: { label: 'Archive format', type: 'select', options: ['pdf', 'pdf_a', 'zip'], default: 'pdf' },
    auto_sign_enabled: { label: 'Auto-sign documents', help: 'Pre-fills company signature blocks on exported documents with the configured signatory.', type: 'boolean', default: true, group: 'Signatures' },
    auto_sign_name: { label: 'Auto-sign name', help: 'Signatory name shown on auto-signed signature blocks. Leave blank to use the company legal name.', type: 'text', group: 'Signatures' },
    auto_sign_role: { label: 'Auto-sign role', help: 'Title or role shown under the auto-sign name (e.g. Managing Director).', type: 'text', default: 'Managing Director', group: 'Signatures' },
  },
};

interface SettingRow {
  category: string;
  key: string;
  value: unknown;
  is_secret: boolean;
}

interface CategoryMetaRow {
  category: string;
  updated_at: string | null;
  updated_by: string | null;
}

const STORED_SQL = `
  SELECT category, key, value, is_secret
  FROM app_settings
  WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
  ORDER BY category, key, (company_id IS NOT NULL) DESC
`;

const META_SQL = `
  SELECT DISTINCT ON (a.category) a.category, a.updated_at,
         (u.first_name || ' ' || u.last_name) AS updated_by
  FROM app_settings a
  LEFT JOIN users u ON u.id = a.updated_by
  WHERE a.tenant_id = $1 AND (a.company_id = $2 OR (a.company_id IS NULL AND $2 IS NULL))
  ORDER BY a.category, a.updated_at DESC
`;

function categoryPayload(categoryId: string, rows: SettingRow[], meta?: CategoryMetaRow | null) {
  const catDef = SETTINGS[categoryId] ?? {};
  const stored = new Map(rows.map((r) => [r.key, r]));
  return {
    category: categoryId,
    label: SETTING_CATEGORIES.find((c) => c.id === categoryId)?.label ?? categoryId,
    blurb: SETTING_CATEGORIES.find((c) => c.id === categoryId)?.blurb ?? '',
    meta: {
      updated_at: meta?.updated_at ?? null,
      updated_by: meta?.updated_by ?? null,
    },
    settings: Object.fromEntries(
      Object.entries(catDef).map(([key, def]) => {
        const row = stored.get(key);
        return [
          key,
          {
            value: row ? row.value : (def.default ?? null),
            default: def.default ?? null,
            label: def.label,
            help: def.help ?? null,
            type: def.type,
            options: def.options ?? null,
            secret: def.secret ?? false,
            group: def.group ?? null,
            saved: Boolean(row),
          },
        ];
      })
    ),
  };
}

/** Full settings catalogue merged with stored values (tenant/company scoped). */
settingsRouter.get(
  '/',
  requirePermission('admin.settings.view'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const [stored, metaRows] = await Promise.all([
      query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx),
      query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx),
    ]);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    const data = SETTING_CATEGORIES.map((cat) => categoryPayload(cat.id, stored.rows, meta.get(cat.id)));
    res.json({ data });
  })
);

/** Recent settings audit trail (who changed what and when). */
settingsRouter.get(
  '/audit',
  requirePermission('admin.settings.view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const tenantId = req.ctx.tenantId;
    const [rows, count] = await Promise.all([
      query(
        `SELECT a.id, a.resource, a.action, a.metadata, a.old_values, a.new_values, a.created_at,
                (u.first_name || ' ' || u.last_name) AS actor
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.tenant_id = $1 AND (a.resource LIKE 'settings.%' OR a.resource = 'settings')
         ORDER BY a.created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, pageSize, (page - 1) * pageSize],
        req.ctx
      ),
      query(
        `SELECT count(*)::int AS n FROM audit_logs
         WHERE tenant_id = $1 AND (resource LIKE 'settings.%' OR resource = 'settings')`,
        [tenantId],
        req.ctx
      ),
    ]);
    res.json({ data: rows.rows, pagination: { page, pageSize, total: count.rows[0].n } });
  })
);

/** Upsert a set of settings for one category (validated + audited). */
settingsRouter.patch(
  '/',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { category?: unknown; values?: unknown };
    const category = typeof body.category === 'string' ? body.category : '';
    const values = body.values;
    if (!category || !values || typeof values !== 'object' || Array.isArray(values)) {
      throw badRequest('Expected { category, values }');
    }
    const catDef = SETTINGS[category];
    if (!catDef) throw badRequest(`Unknown settings category: ${category}`);
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) throw badRequest('No settings to update');

    const normalized: Record<string, unknown> = {};
    for (const [key, raw] of entries) {
      const def = catDef[key];
      if (!def) throw badRequest(`Unknown setting: ${category}.${key}`);
      if (def.type === 'boolean') {
        if (typeof raw !== 'boolean') throw badRequest(`Setting ${category}.${key} must be a boolean`);
        normalized[key] = raw;
      } else if (def.type === 'number') {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n)) {
          throw badRequest(`Setting ${category}.${key} must be a number`);
        }
        normalized[key] = n;
      } else {
        const s = raw == null ? '' : String(raw);
        if (def.type === 'select' && def.options && !def.options.includes(s)) {
          throw badRequest(`Setting ${category}.${key} must be one of: ${def.options.join(', ')}`);
        }
        normalized[key] = s;
      }
    }

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const changes: { key: string; old: unknown; new: unknown }[] = [];

    await tx(
      async (client: pg.PoolClient) => {
        for (const [key, value] of Object.entries(normalized)) {
          const def = catDef[key];
          const prev = await client.query<{ value: unknown }>(
            `SELECT value FROM app_settings
             WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
               AND category = $3 AND key = $4
             ORDER BY (company_id IS NOT NULL) DESC
             LIMIT 1`,
            [tenantId, companyId, category, key]
          );
          const oldValue = prev.rows[0]?.value ?? def.default ?? null;
          await client.query(
            `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT (tenant_id, company_id, category, key)
             DO UPDATE SET value = EXCLUDED.value,
                           is_secret = EXCLUDED.is_secret,
                           updated_by = EXCLUDED.updated_by,
                           updated_at = now()`,
            [tenantId, companyId, category, key, JSON.stringify(value), def.secret ?? false, req.ctx.userId ?? null]
          );
          changes.push({ key, old: oldValue, new: value });
        }
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: `settings.${category}`,
          metadata: { keys: changes.map((c) => c.key) },
          oldValues: Object.fromEntries(changes.map((c) => [c.key, c.old])),
          newValues: Object.fromEntries(changes.map((c) => [c.key, c.new])),
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload(category, fresh.rows.filter((r) => r.category === category), meta.get(category)),
    });
  })
);

/** Upload the company logo (stored on disk; persisted as general.logo_url). */
settingsRouter.post(
  '/logo',
  requirePermission('admin.settings.update'),
  logoUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('A logo file is required (field "file")');
    const ext = LOGO_MIME_EXT[file.mimetype];
    if (!ext) throw badRequest('Unsupported image type. Use PNG, JPG or WebP.');
    assertImageMagic(file.buffer, ext);

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const storageKey = logoStorageKey(tenantId, companyId, ext);
    const absolute = path.join(config.storageRoot, storageKey);

    for (const oldExt of LOGO_EXTS) {
      const oldPath = path.join(config.storageRoot, logoStorageKey(tenantId, companyId, oldExt));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.buffer);

    const logoUrl = `${config.apiPublicUrl}/api/public/branding/logo?tenant=${tenantId}&company=${companyId ?? 0}&t=${Date.now()}`;

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'logo_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'logo_url', $3::jsonb, false, $4)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, JSON.stringify(logoUrl), req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'logo_url',
          metadata: { uploaded: true, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
          oldValues: { logo_url: prev.rows[0]?.value ?? '' },
          newValues: { logo_url: logoUrl },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Upload the browser tab favicon (stored on disk; persisted as general.favicon_url). */
settingsRouter.post(
  '/favicon',
  requirePermission('admin.settings.update'),
  faviconUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('A favicon file is required (field "file")');
    const ext = FAVICON_MIME_EXT[file.mimetype];
    if (!ext) throw badRequest('Unsupported favicon type. Use PNG or ICO.');
    assertImageMagic(file.buffer, ext);

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const storageKey = faviconStorageKey(tenantId, companyId, ext);
    const absolute = path.join(config.storageRoot, storageKey);

    for (const oldExt of FAVICON_EXTS) {
      const oldPath = path.join(config.storageRoot, faviconStorageKey(tenantId, companyId, oldExt));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.buffer);

    const faviconUrl = `${config.apiPublicUrl}/api/public/branding/favicon?tenant=${tenantId}&company=${companyId ?? 0}&t=${Date.now()}`;

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'favicon_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'favicon_url', $3::jsonb, false, $4)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, JSON.stringify(faviconUrl), req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'favicon_url',
          metadata: { uploaded: true, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
          oldValues: { favicon_url: prev.rows[0]?.value ?? '' },
          newValues: { favicon_url: faviconUrl },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Remove the uploaded browser tab favicon and clear general.favicon_url. */
settingsRouter.delete(
  '/favicon',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;

    for (const ext of FAVICON_EXTS) {
      const oldPath = path.join(config.storageRoot, faviconStorageKey(tenantId, companyId, ext));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'favicon_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'favicon_url', '""'::jsonb, false, $3)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'favicon_url',
          metadata: { removed: true },
          oldValues: { favicon_url: prev.rows[0]?.value ?? '' },
          newValues: { favicon_url: '' },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Remove the uploaded company logo and clear general.logo_url. */
settingsRouter.delete(
  '/logo',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;

    for (const ext of LOGO_EXTS) {
      const oldPath = path.join(config.storageRoot, logoStorageKey(tenantId, companyId, ext));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'logo_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'logo_url', '""'::jsonb, false, $3)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'logo_url',
          metadata: { removed: true },
          oldValues: { logo_url: prev.rows[0]?.value ?? '' },
          newValues: { logo_url: '' },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Upload the footer logo (stored on disk; persisted as general.footer_logo_url). */
settingsRouter.post(
  '/footer-logo',
  requirePermission('admin.settings.update'),
  footerLogoUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('A footer logo file is required (field "file")');
    const ext = FOOTER_LOGO_MIME_EXT[file.mimetype];
    if (!ext) throw badRequest('Unsupported image type. Use PNG or JPG.');

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const storageKey = footerLogoStorageKey(tenantId, companyId, ext);
    const absolute = path.join(config.storageRoot, storageKey);

    for (const oldExt of FOOTER_LOGO_EXTS) {
      const oldPath = path.join(config.storageRoot, footerLogoStorageKey(tenantId, companyId, oldExt));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.buffer);

    const footerLogoUrl = `${config.apiPublicUrl}/api/public/branding/footer-logo?tenant=${tenantId}&company=${companyId ?? 0}&t=${Date.now()}`;

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'footer_logo_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'footer_logo_url', $3::jsonb, false, $4)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, JSON.stringify(footerLogoUrl), req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'footer_logo_url',
          metadata: { uploaded: true, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
          oldValues: { footer_logo_url: prev.rows[0]?.value ?? '' },
          newValues: { footer_logo_url: footerLogoUrl },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Remove the uploaded footer logo and clear general.footer_logo_url. */
settingsRouter.delete(
  '/footer-logo',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;

    for (const ext of FOOTER_LOGO_EXTS) {
      const oldPath = path.join(config.storageRoot, footerLogoStorageKey(tenantId, companyId, ext));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'footer_logo_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'footer_logo_url', '""'::jsonb, false, $3)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'footer_logo_url',
          metadata: { removed: true },
          oldValues: { footer_logo_url: prev.rows[0]?.value ?? '' },
          newValues: { footer_logo_url: '' },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Upload the document signature image (stored on disk; persisted as general.signature_url). */
settingsRouter.post(
  '/signature',
  requirePermission('admin.settings.update'),
  signatureUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('A signature file is required (field "file")');
    const ext = SIGNATURE_MIME_EXT[file.mimetype];
    if (!ext) throw badRequest('Unsupported image type. Use PNG or JPG.');

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const storageKey = signatureStorageKey(tenantId, companyId, ext);
    const absolute = path.join(config.storageRoot, storageKey);

    for (const oldExt of SIGNATURE_EXTS) {
      const oldPath = path.join(config.storageRoot, signatureStorageKey(tenantId, companyId, oldExt));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.buffer);

    const signatureUrl = `${config.apiPublicUrl}/api/public/branding/signature?tenant=${tenantId}&company=${companyId ?? 0}&t=${Date.now()}`;

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'signature_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'signature_url', $3::jsonb, false, $4)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, JSON.stringify(signatureUrl), req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'signature_url',
          metadata: { uploaded: true, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
          oldValues: { signature_url: prev.rows[0]?.value ?? '' },
          newValues: { signature_url: signatureUrl },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Remove the uploaded signature image and clear general.signature_url. */
settingsRouter.delete(
  '/signature',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;

    for (const ext of SIGNATURE_EXTS) {
      const oldPath = path.join(config.storageRoot, signatureStorageKey(tenantId, companyId, ext));
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    await tx(
      async (client: pg.PoolClient) => {
        const prev = await client.query<{ value: unknown }>(
          `SELECT value FROM app_settings
           WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
             AND category = 'general' AND key = 'signature_url'
           ORDER BY (company_id IS NOT NULL) DESC
           LIMIT 1`,
          [tenantId, companyId]
        );
        await client.query(
          `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
           VALUES ($1, $2, 'general', 'signature_url', '""'::jsonb, false, $3)
           ON CONFLICT (tenant_id, company_id, category, key)
           DO UPDATE SET value = EXCLUDED.value, is_secret = false,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, companyId, req.ctx.userId ?? null]
        );
        await logAudit(client, req.ctx, {
          action: 'update',
          resource: 'settings.general',
          recordCode: 'signature_url',
          metadata: { removed: true },
          oldValues: { signature_url: prev.rows[0]?.value ?? '' },
          newValues: { signature_url: '' },
        });
      },
      req.ctx
    );

    const fresh = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    res.json({
      data: categoryPayload('general', fresh.rows.filter((r) => r.category === 'general'), meta.get('general')),
    });
  })
);

/** Reset one category (or everything) back to defaults. */
settingsRouter.post(
  '/reset',
  requirePermission('admin.settings.update'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { category?: unknown; all?: unknown };
    const category = typeof body.category === 'string' ? body.category : '';
    const all = body.all === true;
    if (!all && !category) throw badRequest('Expected { category } or { all: true }');
    if (!all && !SETTINGS[category]) throw badRequest(`Unknown settings category: ${category}`);

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;

    await tx(
      async (client: pg.PoolClient) => {
const preservedUploads = ['logo_url', 'favicon_url', 'signature_url', 'footer_logo_url'];
        const del = all
          ? await client.query(
              `DELETE FROM app_settings
               WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
                 AND key <> ALL($3::text[])`,
              [tenantId, companyId, preservedUploads]
            )
          : await client.query(
              `DELETE FROM app_settings
               WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL)) AND category = $3
                 AND key <> ALL($4::text[])`,
              [tenantId, companyId, category, preservedUploads]
            );
        await logAudit(client, req.ctx, {
          action: 'reset',
          resource: all ? 'settings' : `settings.${category}`,
          metadata: { reset: all ? 'all' : category, deleted: del.rowCount ?? 0 },
        });
      },
      req.ctx
    );

    const stored = await query<SettingRow>(STORED_SQL, [tenantId, companyId], req.ctx);
    const metaRows = await query<CategoryMetaRow>(META_SQL, [tenantId, companyId], req.ctx);
    const meta = new Map(metaRows.rows.map((m) => [m.category, m]));
    const data = all
      ? SETTING_CATEGORIES.map((cat) => categoryPayload(cat.id, stored.rows, meta.get(cat.id)))
      : [categoryPayload(category, stored.rows.filter((r) => r.category === category), meta.get(category))];
    res.json({ data });
  })
);
