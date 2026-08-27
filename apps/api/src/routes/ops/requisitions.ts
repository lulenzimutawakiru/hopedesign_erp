import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { stringify } from 'csv-stringify/sync';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import { logAudit } from '../../services/audit.js';
import {
  documentVerifyUrl,
  issueDocumentToken,
  loadCompanyProfile,
  reportFingerprint,
} from '../../services/branding.js';
import {
  renderTablePdf,
  renderTablePrintHtml,
  renderTableXlsx,
  type BrandedTableColumn,
} from '../../services/brandedExport.js';
import * as reqs from '../../services/requisitions.js';
import * as exp from '../../services/expenses.js';

export const requisitionsOpsRouter = Router();
const reqUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const EXPORT_COLUMNS: { key: string; label: string; align?: 'right' }[] = [
  { key: 'req_no', label: 'Req No' },
  { key: 'request_type', label: 'Request Type' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'fulfillment_method', label: 'Fulfillment Method' },
  { key: 'is_emergency', label: 'Emergency' },
  { key: 'risk_level', label: 'Risk Level' },
  { key: 'department_code', label: 'Department Code' },
  { key: 'department_name', label: 'Department' },
  { key: 'cost_centre_code', label: 'Cost Centre Code' },
  { key: 'cost_centre_name', label: 'Cost Centre' },
  { key: 'project_code', label: 'Project Code' },
  { key: 'project_name', label: 'Project' },
  { key: 'warehouse_code', label: 'Warehouse Code' },
  { key: 'warehouse_name', label: 'Warehouse' },
  { key: 'budget_no', label: 'Budget No' },
  { key: 'requester_name', label: 'Requester' },
  { key: 'employee_name', label: 'Employee' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'required_date', label: 'Required Date' },
  { key: 'estimated_total', label: 'Est. Total', align: 'right' },
  { key: 'currency', label: 'Currency' },
  { key: 'submitted_at', label: 'Submitted At' },
  { key: 'approved_at', label: 'Approved At' },
  { key: 'fulfilled_at', label: 'Fulfilled At' },
  { key: 'cancelled_at', label: 'Cancelled At' },
  { key: 'created_at', label: 'Created At' },
  { key: 'updated_at', label: 'Updated At' },
];

/** Curated register columns for branded PDF/print (full data stays in CSV/XLSX/JSON). */
const PDF_COLUMNS: BrandedTableColumn[] = [
  { key: 'req_no', label: 'Req No' },
  { key: 'request_type', label: 'Type' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'fulfillment_method', label: 'Fulfil. Method' },
  { key: 'department', label: 'Department' },
  { key: 'cost_centre', label: 'Cost Centre' },
  { key: 'project', label: 'Project' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'budget_no', label: 'Budget' },
  { key: 'requester_name', label: 'Requester' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'required_date', label: 'Req. Date' },
  { key: 'estimated_total', label: 'Est. Total', align: 'right' },
  { key: 'currency', label: 'Currency' },
  { key: 'submitted_at', label: 'Submitted' },
];

/** Map a raw requisition row into the compact register columns used by PDF/print. */
function pdfRowOf(r: Record<string, unknown>): Record<string, unknown> {
  const firstOf = (...parts: unknown[]): string =>
    parts.map((p) => String(p ?? '').trim()).find(Boolean) ?? '';
  return {
    req_no: r.req_no,
    request_type: r.request_type,
    priority: r.priority,
    status: r.status,
    fulfillment_method: r.fulfillment_method,
    department: firstOf(r.department_name, r.department_code),
    cost_centre: firstOf(r.cost_centre_name, r.cost_centre_code),
    project: firstOf(r.project_name, r.project_code),
    warehouse: firstOf(r.warehouse_name, r.warehouse_code),
    budget_no: r.budget_no,
    requester_name: r.requester_name,
    purpose: r.purpose,
    required_date: r.required_date,
    estimated_total: r.estimated_total,
    currency: r.currency,
    submitted_at: r.submitted_at,
  };
}

const EXPORT_SELECT = `
  SELECT r.id, r.req_no, r.request_type, r.priority, r.status, r.fulfillment_method,
         r.is_emergency, r.risk_level, r.required_date, r.estimated_total, r.currency,
         r.purpose, r.submitted_at, r.approved_at, r.fulfilled_at,
         r.cancelled_at, r.created_at, r.updated_at,
         d.code AS department_code, d.name AS department_name,
         cc.code AS cost_centre_code, cc.name AS cost_centre_name,
         p.code AS project_code, p.name AS project_name,
         w.code AS warehouse_code, w.name AS warehouse_name,
         b.budget_no,
         (u.first_name || ' ' || u.last_name) AS requester_name,
         (e.first_name || ' ' || e.last_name) AS employee_name
  FROM requisitions r
  LEFT JOIN departments d ON d.id = r.department_id
  LEFT JOIN cost_centres cc ON cc.id = r.cost_centre_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN warehouses w ON w.id = r.warehouse_id
  LEFT JOIN budgets b ON b.id = r.budget_id
  LEFT JOIN users u ON u.id = r.requested_by
  LEFT JOIN employees e ON e.id = r.employee_id
`;

requisitionsOpsRouter.get('/meta', ...runGet('expenditure.requisitions.view', (c, ctx) => reqs.requisitionMeta(c, ctx)));
requisitionsOpsRouter.get('/items', ...runGet('expenditure.requisitions.view', (c, ctx, q) => reqs.smartItemLookup(c, ctx, { q: q.q })));
requisitionsOpsRouter.get('/board', ...runGet('expenditure.requisitions.view', (c, ctx) => reqs.requisitionBoard(c, ctx)));
requisitionsOpsRouter.get('/summary', ...runGet('expenditure.requisitions.view', (c, ctx) => reqs.requisitionSummary(c, ctx)));
requisitionsOpsRouter.get('/reports', ...runGet('expenditure.requisitions.view', (c, ctx, q) => reqs.requisitionReports(c, ctx, {
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  departmentId: q.departmentId != null ? Number(q.departmentId) : undefined,
  type: q.type != null ? String(q.type) : undefined,
})));
requisitionsOpsRouter.get(
  '/export',
  requirePermission('expenditure.requisitions.view'),
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'pdf').toLowerCase();
    const ALLOWED = ['pdf', 'print', 'xlsx', 'csv', 'json'];
    if (!ALLOWED.includes(format)) throw badRequest(`Unsupported export format ${format}`);

    const companyIdVal = req.ctx.companyId;
    if (!companyIdVal) throw badRequest('Company context required');

    const q = req.query.q != null ? String(req.query.q) : undefined;
    const status = req.query.status != null ? String(req.query.status) : undefined;
    const type = req.query.type != null ? String(req.query.type) : undefined;
    const departmentId = req.query.departmentId != null ? Number(req.query.departmentId) : undefined;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 1000) || 1000));

    const params: unknown[] = [companyIdVal, req.ctx.tenantId];
    const where: string[] = ['r.company_id = $1', 'r.tenant_id = $2'];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(r.req_no ILIKE $${params.length} OR r.purpose ILIKE $${params.length})`);
    }
    if (status) {
      params.push(String(status).toUpperCase());
      where.push(`r.status = $${params.length}`);
    }
    if (type) {
      params.push(String(type).toUpperCase());
      where.push(`r.request_type = $${params.length}`);
    }
    if (departmentId) {
      params.push(departmentId);
      where.push(`r.department_id = $${params.length}`);
    }
    params.push(limit);

    const rows = await tx(
      async (client) => {
        const out = await client.query(
          `${EXPORT_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${params.length}`,
          params
        );
        return out.rows as Array<Record<string, unknown>>;
      },
      req.ctx
    );

    const issuedAt = new Date().toISOString();
    const issuedByEmail = req.auth?.email ?? 'unknown';
    const issuedBy = [req.auth?.first_name, req.auth?.last_name].filter(Boolean).join(' ') || issuedByEmail;

    await tx(async (client) => {
      await logAudit(client, req.ctx, {
        action: format === 'print' ? 'print' : 'export',
        resource: 'requisitions',
        metadata: { format, rows: rows.length, filters: { status, type, q, departmentId } },
      });
    }, req.ctx);

    if (format === 'json') {
      return res.json({
        data: rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const c of EXPORT_COLUMNS) out[toCamel(c.key)] = r[c.key] ?? null;
          return out;
        }),
        meta: {
          table: 'requisitions',
          format,
          rows: rows.length,
          filters: { status, type, q, departmentId },
          exportedAt: issuedAt,
          exportedBy: issuedBy,
        },
      });
    }

    const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
    const fingerprint = reportFingerprint('requisitions', EXPORT_COLUMNS.map((c) => c.key), rows);
    const token = company.verifyEnabled
      ? issueDocumentToken({
          type: 'export.requisitions',
          id: 0,
          code: 'REQUISITIONS',
          title: 'Requisitions',
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
    const common = {
      title: 'Requisitions',
      subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}`,
      kicker: 'Ops register',
      docNo: 'REQUISITIONS',
      company,
      issuedBy,
      issuedAt,
      correlationId: req.ctx.correlationId ?? null,
      facts: [
        ['Status', status ? String(status).toUpperCase() : 'ALL'],
        ['Rows', String(rows.length)],
      ] as [string, string][],
      fingerprint,
      token,
      verifyUrl,
      classification: 'Internal',
    };

    if (format === 'pdf' || format === 'print') {
      const pdf = { ...common, columns: PDF_COLUMNS, rows: rows.map(pdfRowOf) };
      if (format === 'pdf') {
        const buf = await renderTablePdf(pdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="requisitions_${Date.now()}.pdf"`);
        return res.send(buf);
      }
      const html = await renderTablePrintHtml(pdf);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    if (format === 'xlsx') {
      const buf = await renderTableXlsx({ ...common, columns: EXPORT_COLUMNS, rows });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="requisitions_${Date.now()}.xlsx"`);
      return res.send(buf);
    }

    const csvRows: unknown[][] = [EXPORT_COLUMNS.map((c) => c.label)];
    for (const row of rows) {
      csvRows.push(
        EXPORT_COLUMNS.map((c) => {
          const v = row[c.key];
          if (v == null || v === '') return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        })
      );
    }
    const csv = stringify(csvRows, { header: false });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="requisitions_${Date.now()}.csv"`);
    return res.send(csv);
  })
);
requisitionsOpsRouter.get('/history/:id', ...runGet('expenditure.requisitions.view', (c, ctx, _q, p) => reqs.requisitionHistory(c, ctx, Number(p.id))));
requisitionsOpsRouter.get('/', ...runGet('expenditure.requisitions.view', (c, ctx, q) => reqs.listRequisitions(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  type: q.type != null ? String(q.type) : undefined,
  departmentId: q.departmentId != null ? Number(q.departmentId) : undefined,
  priority: q.priority != null ? String(q.priority) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
requisitionsOpsRouter.get('/:id', ...runGet('expenditure.requisitions.view', (c, ctx, _q, p) => reqs.getRequisition(c, ctx, Number(p.id))));
requisitionsOpsRouter.post('/', ...run('expenditure.requisitions.create', (c, ctx, b) => reqs.createRequisition(c, ctx, b)));
requisitionsOpsRouter.post('/:id/update', ...run('expenditure.requisitions.update', (c, ctx, b, p) => reqs.updateRequisition(c, ctx, Number(p.id), b)));
requisitionsOpsRouter.post('/:id/submit', ...run('expenditure.requisitions.submit', (c, ctx, _b, p) => reqs.submitRequisition(c, ctx, Number(p.id))));
requisitionsOpsRouter.post('/:id/cancel', ...run('expenditure.requisitions.cancel', (c, ctx, b, p) => reqs.cancelRequisition(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
requisitionsOpsRouter.post('/:id/inventory-check', ...run('expenditure.requisitions.fulfill', (c, ctx, _b, p) => reqs.requisitionInventoryCheck(c, ctx, Number(p.id))));
requisitionsOpsRouter.post('/:id/fulfill', ...run('expenditure.requisitions.fulfill', (c, ctx, _b, p) => reqs.fulfillRequisition(c, ctx, Number(p.id))));

// Attachments (multer) - receipt / supporting document for a requisition
requisitionsOpsRouter.post(
  '/:id/attachments',
  requirePermission('expenditure.requisitions.update'),
  reqUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A file is required (field "file")');
    const out = await tx(
      (client) =>
        exp.uploadReceipt(client, req.ctx, {
          refType: 'REQUISITION',
          refId: Number(req.params.id),
          file: {
            originalname: req.file!.originalname,
            mimetype: req.file!.mimetype,
            size: req.file!.size,
            buffer: req.file!.buffer,
          },
          supplier: req.body.supplier != null ? String(req.body.supplier) : null,
          invoiceNo: req.body.invoiceNo != null ? String(req.body.invoiceNo) : null,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);

requisitionsOpsRouter.get('/:id/attachments', ...runGet('expenditure.requisitions.view', (c, ctx, _q, p) => exp.listReceipts(c, ctx, { refType: 'REQUISITION', refId: Number(p.id) })));
