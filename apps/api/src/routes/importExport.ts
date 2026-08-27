import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { query, tx, type Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { ENTITIES, entityForTable } from './registry.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { logAudit } from '../services/audit.js';
import {
  documentVerifyUrl,
  issueDocumentToken,
  loadCompanyProfile,
  reportFingerprint,
} from '../services/branding.js';
import { renderTablePdf, renderTablePrintHtml } from '../services/brandedExport.js';

export const importExportRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const BASE_EXCLUDED = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'company_id', 'tenant_id', 'branch_id',
]);

/** Domain tables outside the CRUD registry that are still exportable. */
const DOMAIN_TABLES: { table: string; label: string }[] = [
  { table: 'reams', label: 'Reams' },
  { table: 'cartons', label: 'Cartons' },
  { table: 'carton_reams', label: 'Carton Reams' },
  { table: 'qr_codes', label: 'QR Codes' },
  { table: 'qr_scans', label: 'QR Scans' },
  { table: 'qr_labels', label: 'QR Labels' },
  { table: 'label_print_jobs', label: 'Label Print Jobs' },
];

/** Sensitive columns that must never appear in exports (QR secrets, hashes, credentials). */
const SENSITIVE_EXCLUDED = new Set(['secret', 'secret_hash', 'password_hash', 'mfa_secret']);

const columnCache = new Map<string, string[]>();

async function columnsOf(table: string): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const res = await query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  const cols = res.rows.map((r) => String(r.column_name));
  columnCache.set(table, cols);
  return cols;
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** "security_classification" / "securityClassification" -> "Security Classification". */
function humanizeColumn(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (ch: string) => ch.toUpperCase());
}

/** Validate a table name against the CRUD registry / export allowlist (no arbitrary SQL). */
function requireTable(table: string): string {
  const t = String(table ?? '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(t)) throw notFound('Unknown import/export table');
  const known = entityForTable(t) || DOMAIN_TABLES.some((d) => d.table === t);
  if (!known) throw notFound('Unknown import/export table');
  return t;
}

/** Friendly display label for an exportable table. */
function tableLabel(table: string): string {
  return (
    entityForTable(table)?.label ??
    DOMAIN_TABLES.find((d) => d.table === table)?.label ??
    table
  );
}

/** Current tenant / company / branch identity for the exporting user. */
async function tenantInfo(ctx: Ctx): Promise<Record<string, string | null>> {
  const res = await query(
    `SELECT t.code AS tenant_code, t.name AS tenant_name,
            c.code AS company_code, c.name AS company_name,
            c.legal_name AS company_legal_name, c.tin AS company_tin, c.vrn AS company_vrn,
            c.website AS company_website, c.address AS company_address,
            c.phone AS company_phone, c.email AS company_email,
            b.code AS branch_code, b.name AS branch_name
     FROM tenants t
     LEFT JOIN companies c ON c.id = $2
     LEFT JOIN branches b ON b.id = $3
     WHERE t.id = $1`,
    [ctx.tenantId ?? 0, ctx.companyId ?? null, ctx.branchId ?? null]
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return {
    tenantCode: row?.tenant_code ? String(row.tenant_code) : null,
    tenantName: row?.tenant_name ? String(row.tenant_name) : null,
    companyCode: row?.company_code ? String(row.company_code) : null,
    companyName: row?.company_name ? String(row.company_name) : null,
    companyLegalName: row?.company_legal_name ? String(row.company_legal_name) : null,
    companyTin: row?.company_tin ? String(row.company_tin) : null,
    companyVrn: row?.company_vrn ? String(row.company_vrn) : null,
    companyWebsite: row?.company_website ? String(row.company_website) : null,
    companyAddress: row?.company_address ? String(row.company_address) : null,
    companyPhone: row?.company_phone ? String(row.company_phone) : null,
    companyEmail: row?.company_email ? String(row.company_email) : null,
    branchCode: row?.branch_code ? String(row.branch_code) : null,
    branchName: row?.branch_name ? String(row.branch_name) : null,
  };
}

importExportRouter.get(
  '/imports/templates/:table',
  requirePermission('admin.imports.download_template'),
  asyncHandler(async (req, res) => {
    const table = requireTable(req.params.table);
    const cols = (await columnsOf(table)).filter((c) => !BASE_EXCLUDED.has(c));
    const csv = stringify([cols], { header: false });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}_template.csv"`);
    res.send(csv);
  })
);

importExportRouter.post(
  '/imports/preview',
  requirePermission('admin.imports.view'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('file is required (multipart field "file")');
    const table = requireTable(String(req.body?.table ?? ''));
    const text = req.file.buffer.toString('utf-8');
    let records: Record<string, unknown>[];
    try {
      records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    } catch {
      throw badRequest('Could not parse CSV file');
    }
    const cols = (await columnsOf(table)).filter((c) => !BASE_EXCLUDED.has(c));
    const unknownCols = Object.keys(records[0] ?? {}).filter((k) => !cols.includes(k));
    if (unknownCols.length > 0) throw badRequest(`Unknown columns: ${unknownCols.join(', ')}`);
    res.json({
      data: {
        table,
        columns: cols,
        rowCount: records.length,
        sample: records.slice(0, 5),
        errors: [],
      },
    });
  })
);

importExportRouter.post(
  '/imports/confirm',
  requirePermission('admin.imports.run'),
  asyncHandler(async (req, res) => {
    const table = requireTable(String(req.body?.table ?? ''));
    const records = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (records.length === 0) throw badRequest('rows is required');
    if (records.length > 5000) throw badRequest('Maximum 5000 rows per import');
    const cols = (await columnsOf(table)).filter((c) => !BASE_EXCLUDED.has(c));
    const ctx = req.ctx;
    const inserted: number[] = [];
    let errors: { row: number; message: string }[] = [];
    await tx(async (client) => {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i] as Record<string, unknown>;
        const keys = Object.keys(rec).filter((k) => cols.includes(k));
        if (keys.length === 0) {
          errors.push({ row: i + 1, message: 'No usable columns' });
          continue;
        }
        const values = keys.map((k) => (rec[k] === '' ? null : rec[k]));
        const placeholders = keys.map((_, j) => `$${j + 1}`).join(', ');
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING id`;
        try {
          const ins = await client.query(sql, values);
          const id = Number(ins.rows[0].id);
          inserted.push(id);
          await logAudit(client, ctx, {
            action: 'import',
            resource: table,
            recordId: id,
            newValues: rec,
          });
        } catch (err) {
          errors.push({ row: i + 1, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }, ctx);
    res.json({ data: { table, imported: inserted.length, inserted, errors } });
  })
);

importExportRouter.get(
  '/exports/tables',
  requirePermission('admin.exports.view'),
  asyncHandler(async (_req, res) => {
    const seen = new Set<string>();
    const all = [...DOMAIN_TABLES, ...ENTITIES.map((e) => ({ table: e.table, label: e.label }))]
      .filter((t) => (seen.has(t.table) ? false : (seen.add(t.table), true)))
      .sort((a, b) => a.label.localeCompare(b.label));
    res.json({ data: all });
  })
);

importExportRouter.get(
  '/exports/history',
  requirePermission('admin.exports.view'),
  asyncHandler(async (req, res) => {
    const res2 = await query(
      `SELECT a.id, a.action, a.resource, a.record_id, a.record_code, a.ip, a.user_agent, a.device,
              a.metadata, a.created_at,
              u.email AS user_email, u.first_name, u.last_name,
              t.code AS tenant_code, t.name AS tenant_name,
              c.code AS company_code, c.name AS company_name,
              b.code AS branch_code, b.name AS branch_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN tenants t ON t.id = a.tenant_id
       LEFT JOIN companies c ON c.id = a.company_id
       LEFT JOIN branches b ON b.id = a.branch_id
       WHERE a.tenant_id = $1 AND a.action IN ('export','print','labels.spool','labels.printed')
       ORDER BY a.id DESC LIMIT 200`,
      [req.ctx.tenantId ?? null],
      req.ctx
    );
    const rows = res2.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
      return {
        id: row.id,
        action: row.action,
        resource: row.resource,
        user: name ? `${name} (${row.user_email ?? ''})` : (row.user_email ?? null),
        email: row.user_email ?? null,
        tenantCode: row.tenant_code ?? null,
        tenantName: row.tenant_name ?? null,
        companyCode: row.company_code ?? null,
        companyName: row.company_name ?? null,
        branchCode: row.branch_code ?? null,
        branchName: row.branch_name ?? null,
        format: meta.format ?? null,
        rows: meta.rows ?? null,
        recordCode: row.record_code ?? null,
        ip: row.ip ?? null,
        createdAt: row.created_at,
      };
    });
    res.json({ data: rows });
  })
);

importExportRouter.get(
  '/exports/:table',
  requirePermission('admin.exports.run'),
  asyncHandler(async (req, res) => {
    const table = requireTable(req.params.table);
    const format = String(req.query.format ?? 'csv').toLowerCase();
    if (!['csv', 'xlsx', 'json', 'pdf', 'print'].includes(format)) {
      throw badRequest(`Unsupported format: ${format}`);
    }
    const limit = Math.min(50000, Math.max(1, Number(req.query.limit) || 10000));
    const rawTenant = String(req.query.includeTenant ?? '');
    const includeTenant = rawTenant === '1' || rawTenant.toLowerCase() === 'true';

    const allCols = await columnsOf(table);
    const cols = allCols.filter((c) => !BASE_EXCLUDED.has(c) && !SENSITIVE_EXCLUDED.has(c));

    const params: unknown[] = [];
    const where: string[] = [];
    if (req.auth!.company_id && allCols.includes('company_id')) {
      params.push(req.auth!.company_id);
      where.push(`company_id = $${params.length}`);
    }
    const scope = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const sql = `SELECT * FROM ${table} ${scope} ORDER BY id LIMIT $${params.length}`;
    const res2 = await query(sql, params, req.ctx);
    const rows = res2.rows as unknown as Record<string, unknown>[];

    const exportedAt = new Date().toISOString();
    const fingerprint = reportFingerprint(table, cols, rows);
    const info: Record<string, string | number | null> | null = includeTenant
      ? {
          ...(await tenantInfo(req.ctx)),
          exportedBy: req.auth?.email ?? null,
          exportedAt,
          rows: rows.length,
          fingerprint,
        }
      : null;

    await tx(async (client) => {
      await logAudit(client, req.ctx, {
        action: format === 'print' ? 'print' : 'export',
        resource: table,
        metadata: { format, rows: rows.length, includeTenant, exportedAt },
      });
    }, req.ctx);

    const header = cols.map(camel);
    const issuedByEmail = req.auth?.email ?? 'unknown';
    const issuedBy = [req.auth?.first_name, req.auth?.last_name].filter(Boolean).join(' ') || issuedByEmail;
    const INFO_LABELS: Record<string, string> = {
      tenantCode: 'Tenant Code',
      tenantName: 'Tenant Name',
      companyCode: 'Company Code',
      companyName: 'Company Name',
      companyLegalName: 'Company Legal Name',
      companyTin: 'TIN',
      companyVrn: 'VRN',
      companyWebsite: 'Website',
      companyAddress: 'Company Address',
      companyPhone: 'Phone',
      companyEmail: 'Email',
      branchCode: 'Branch Code',
      branchName: 'Branch Name',
      exportedBy: 'Exported By',
      exportedAt: 'Exported At',
      rows: 'Rows Exported',
      fingerprint: 'SHA-256 Fingerprint',
    };

    if (format === 'pdf' || format === 'print') {
      const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
      const issuedAt = new Date().toISOString();
      const label = tableLabel(table);
      const fingerprint = reportFingerprint(table, cols, rows);
      const token = company.verifyEnabled
        ? issueDocumentToken({
            type: `export.${table}`,
            id: 0,
            code: table,
            title: label,
            fingerprint,
            issuedAt,
            tenantId: req.ctx.tenantId ?? 0,
            companyId: req.ctx.companyId ?? null,
            companyName: company.name,
            issuer: issuedByEmail,
            issuerName: issuedBy,
            kind: 'export',
          })
        : '';
      const verifyUrl = token ? documentVerifyUrl(company, token) : '';
      const columns = cols.map((c) => ({ key: c, label: humanizeColumn(c) }));
      const common = {
        title: `${label} Export`,
        subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}`,
        kicker: 'Data export',
        docNo: table,
        company,
        issuedBy,
        issuedAt,
        correlationId: req.ctx.correlationId ?? null,
        facts:
          includeTenant && info
            ? ([['Exported By', String(info.exportedBy ?? '')]] as [string, string][])
            : undefined,
        columns,
        rows,
        fingerprint,
        token,
        verifyUrl,
        classification: 'Internal',
      };
      if (format === 'pdf') {
        const buf = await renderTablePdf(common);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${table}_export_${Date.now()}.pdf"`);
        return res.send(buf);
      }
      const html = await renderTablePrintHtml(common);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (format === 'json') {
      return res.json({
        data: rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const c of cols) out[camel(c)] = r[c] ?? null;
          return out;
        }),
        meta: { table, format, rows: rows.length, includeTenant, tenant: info, fingerprint },
      });
    }

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(table.slice(0, 31));
      if (info) {
        for (const [k, v] of Object.entries(info)) ws.addRow([INFO_LABELS[k] ?? k, v == null ? '' : v]);
        ws.addRow([]);
      }
      ws.addRow(header);
      for (const row of rows) ws.addRow(cols.map((c) => (row[c] == null ? '' : row[c])));
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${table}_export_${Date.now()}.xlsx"`);
      return res.send(buf);
    }

    const out: (string | number | boolean | null)[][] = [];
    if (info) {
      for (const [k, v] of Object.entries(info)) out.push([INFO_LABELS[k] ?? k, v == null ? '' : String(v)]);
      out.push([]);
    }
    out.push(header);
    for (const row of rows) {
      out.push(
        cols.map((c) => {
          const v = row[c];
          if (v == null || v === '') return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        })
      );
    }
    const csv = stringify(out, { header: false });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}_export_${Date.now()}.csv"`);
    return res.send(csv);
  })
);
