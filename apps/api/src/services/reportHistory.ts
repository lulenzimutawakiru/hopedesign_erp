import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

export const REPORT_SOURCES = ['ERP', 'EFRIS_PORTAL'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const REPORT_STATUSES = ['GENERATED', 'REQUESTED', 'RECEIVED', 'FAILED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportHistoryInput {
  reportType: string;
  source?: string;
  status?: string;
  period?: string | null;
  title?: string | null;
  summary?: Record<string, unknown> | null;
  attachmentPath?: string | null;
  notes?: string | null;
}

function assertSource(s: unknown): asserts s is ReportSource {
  if (typeof s !== 'string' || !(REPORT_SOURCES as readonly string[]).includes(s)) {
    throw badRequest(`Invalid source "${String(s)}"; expected one of: ${REPORT_SOURCES.join(', ')}`);
  }
}

function assertStatus(s: unknown): asserts s is ReportStatus {
  if (typeof s !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(s)) {
    throw badRequest(`Invalid status "${String(s)}"; expected one of: ${REPORT_STATUSES.join(', ')}`);
  }
}

export async function listReports(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { reportType?: string; source?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 100), 500);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [ctx.tenantId];
  let where = 'r.tenant_id = $1';
  if (opts.reportType && String(opts.reportType).trim()) {
    params.push(String(opts.reportType).trim().toUpperCase());
    where += ` AND r.report_type = $${params.length}`;
  }
  if (opts.source && String(opts.source).trim()) {
    params.push(String(opts.source).trim().toUpperCase());
    where += ` AND r.source = $${params.length}`;
  }
  if (opts.status && String(opts.status).trim()) {
    params.push(String(opts.status).trim().toUpperCase());
    where += ` AND r.status = $${params.length}`;
  }
  const total = await client.query(`SELECT COUNT(*)::int AS n FROM report_history r WHERE ${where}`, params);
  params.push(pageSize, offset);
  const rows = await client.query(
    `SELECT r.*, cb.username AS created_by_name
       FROM report_history r
       LEFT JOIN users cb ON cb.id = r.created_by
      WHERE ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: toCamelRows(rows.rows), pagination: { page, pageSize, total: Number(total.rows[0].n) } };
}

export async function getReport(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT r.*, cb.username AS created_by_name
       FROM report_history r
       LEFT JOIN users cb ON cb.id = r.created_by
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Report history entry not found');
  return toCamelRow(res.rows[0]);
}

/**
 * Append a report-history entry. For portal-only URA reports (Z-report, VAT
 * return, registers) this is the controlled manual trail: an operator records
 * that a report was requested and later that it was received, so the ERP never
 * claims to hold an official report it does not.
 */
export async function recordReport(client: pg.PoolClient, ctx: Ctx, input: ReportHistoryInput) {
  const reportType = String(input.reportType ?? '').trim().toUpperCase();
  if (!reportType) throw badRequest('reportType is required');
  const source = input.source != null ? String(input.source).toUpperCase() : 'ERP';
  assertSource(source);
  const status = input.status != null ? String(input.status).toUpperCase() : 'GENERATED';
  assertStatus(status);

  const ins = await client.query(
    `INSERT INTO report_history
       (company_id, tenant_id, report_type, source, status, period, title, summary, attachment_path, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [ctx.companyId, ctx.tenantId, reportType, source, status,
     input.period != null ? String(input.period) : null,
     input.title != null ? String(input.title) : null,
     input.summary != null ? JSON.stringify(input.summary) : null,
     input.attachmentPath != null ? String(input.attachmentPath) : null,
     input.notes != null ? String(input.notes) : null,
     ctx.userId]
  );
  await logAudit(client, ctx, {
    action: 'record', resource: 'report_history', recordId: Number(ins.rows[0].id),
    recordCode: reportType, newValues: { source, status },
  });
  return toCamelRow(ins.rows[0]);
}

/** Update an existing report-history entry (e.g. REQUESTED -> RECEIVED/FAILED). */
export async function updateReport(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { status?: string; attachmentPath?: string | null; notes?: string | null; summary?: Record<string, unknown> | null }
) {
  const cur = await client.query(
    `SELECT * FROM report_history WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, ctx.tenantId]
  );
  if (cur.rows.length === 0) throw notFound('Report history entry not found');

  let status = String(cur.rows[0].status);
  if (input.status != null) {
    assertStatus(String(input.status).toUpperCase());
    status = String(input.status).toUpperCase();
  }

  const upd = await client.query(
    `UPDATE report_history SET
       status = $3,
       attachment_path = COALESCE($4, attachment_path),
       notes = COALESCE($5, notes),
       summary = COALESCE($6, summary),
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, ctx.tenantId, status,
     input.attachmentPath != null ? String(input.attachmentPath) : null,
     input.notes != null ? String(input.notes) : null,
     input.summary != null ? JSON.stringify(input.summary) : null]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'report_history', recordId: id,
    recordCode: String(cur.rows[0].report_type),
    oldValues: { status: cur.rows[0].status }, newValues: { status },
  });
  return toCamelRow(upd.rows[0]);
}
