import pg from 'pg';
import { Ctx } from '../db.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden, notFound } from '../utils.js';
import { config } from '../config.js';
import { logAudit } from './audit.js';
import { emitEvent } from './events.js';
import { generateQr, voidQr, findQrByCode } from './qr.js';
import { startWorkflow } from './workflow.js';
import { notifyRoleAdvanced, notifyUserAdvanced } from './communication.js';
import * as inv from './inventory.js';
import * as finance from './finance.js';
import { loadCompanyProfile } from './branding.js';
import { renderDocument } from './documents.js';

// ============================================================
// Hope Design ERP - Enterprise Asset Management service
// Asset Register, Tagging, Tracking and full lifecycle:
// PROCUREMENT -> RECEIVING -> REGISTRATION -> TAGGING ->
// ASSIGNMENT -> LOCATION -> USE -> TRANSFER -> MAINTENANCE ->
// AUDIT -> DEPRECIATION -> IMPAIRMENT -> DISPOSAL -> RETIREMENT.
// Every function runs inside the caller's transaction with app
// context applied and writes timeline + audit records.
// ============================================================

function n(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function s(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const x = String(v).trim();
  return x === '' ? null : x;
}

function num0(v: unknown): number {
  const x = n(v);
  return x ?? 0;
}

async function timeline(
  client: pg.PoolClient,
  ctx: Ctx,
  assetId: number,
  e: {
    eventType: string;
    title: string;
    description?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    locationId?: number | null;
    reason?: string | null;
    referenceDocId?: number | null;
    metadata?: Record<string, unknown>;
  }
) {
  await client.query(
    `INSERT INTO asset_timeline
       (company_id, tenant_id, asset_id, event_type, title, description, user_id,
        old_value, new_value, location_id, reason, reference_doc_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.companyId,
      ctx.tenantId,
      assetId,
      e.eventType,
      e.title,
      e.description ?? null,
      ctx.userId ?? null,
      e.oldValue === undefined || e.oldValue === null ? null : JSON.stringify(e.oldValue),
      e.newValue === undefined || e.newValue === null ? null : JSON.stringify(e.newValue),
      e.locationId ?? null,
      e.reason ?? null,
      e.referenceDocId ?? null,
      JSON.stringify(e.metadata ?? {}),
    ]
  );
}

async function loadAsset(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query('SELECT * FROM asset_register WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (res.rows.length === 0) throw notFound('Asset not found');
  return res.rows[0];
}

async function nextNo(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

const TAG_ASSIGNABLE = new Set(['REGISTERED', 'IN_STORE', 'AVAILABLE', 'TRANSFERRED', 'RESERVED']);
const CUSTODY_RELEASED = new Set(['UNASSIGNED', 'RETURNED', 'TRANSFERRED', 'RELEASED']);

// ------------------------------------------------------------
// Read models
// ------------------------------------------------------------

export async function listAssets(
  client: pg.PoolClient,
  ctx: Ctx,
  q: {
    search?: string;
    status?: string;
    condition?: string;
    categoryId?: number | null;
    typeId?: number | null;
    locationId?: number | null;
    custodianId?: number | null;
    departmentId?: number | null;
    branchId?: number | null;
    supplierId?: number | null;
    isMachine?: boolean;
    highValue?: boolean;
    unassigned?: boolean;
    dueMaintenance?: boolean;
    dueInspection?: boolean;
    nearEol?: boolean;
    mine?: boolean;
    includeDisposed?: boolean;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['t.tenant_id = $1', 't.company_id = $2'];
  if (!q.includeDisposed) where.push('NOT t.is_deleted');
  if (ctx.branchId) {
    params.push(ctx.branchId);
    where.push(`(t.branch_id = $${params.length} OR t.branch_id IS NULL)`);
  }
  if (q.search) {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where.push(
      `(LOWER(t.asset_no) LIKE $${params.length} OR LOWER(t.name) LIKE $${params.length}
        OR LOWER(t.serial_no) LIKE $${params.length} OR LOWER(t.barcode) LIKE $${params.length}
        OR LOWER(t.sku) LIKE $${params.length} OR LOWER(t.model) LIKE $${params.length}
        OR LOWER(t.machine_ref) LIKE $${params.length})`
    );
  }
  if (q.status) {
    const statuses = String(q.status).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (statuses.length) {
      params.push(statuses);
      where.push(`t.status = ANY($${params.length}::text[])`);
    }
  }
  if (q.condition) {
    params.push(String(q.condition).toUpperCase());
    where.push(`t.condition = $${params.length}`);
  }
  if (q.categoryId) {
    params.push(q.categoryId);
    where.push(`t.category_id = $${params.length}`);
  }
  if (q.typeId) {
    params.push(q.typeId);
    where.push(`t.type_id = $${params.length}`);
  }
  if (q.locationId) {
    params.push(q.locationId);
    where.push(`t.location_id = $${params.length}`);
  }
  if (q.custodianId) {
    params.push(q.custodianId);
    where.push(`t.custodian_user_id = $${params.length}`);
  }
  if (q.departmentId) {
    params.push(q.departmentId);
    where.push(`t.department_id = $${params.length}`);
  }
  if (q.branchId) {
    params.push(q.branchId);
    where.push(`t.branch_id = $${params.length}`);
  }
  if (q.supplierId) {
    params.push(q.supplierId);
    where.push(`t.supplier_id = $${params.length}`);
  }
  if (q.isMachine) where.push('t.is_machine = true');
  if (q.highValue) where.push('t.is_high_value = true');
  if (q.unassigned) {
    where.push(`t.custody_status = 'UNASSIGNED'`);
    where.push(`t.status NOT IN ('DISPOSED','RETIRED','ARCHIVED')`);
  }
  if (q.mine && ctx.userId) {
    params.push(ctx.userId);
    where.push(`(t.custodian_user_id = $${params.length} OR t.created_by = $${params.length})`);
  }
  if (q.dueMaintenance) where.push(`t.next_maintenance IS NOT NULL AND t.next_maintenance <= now() + interval '30 days'`);
  if (q.dueInspection) where.push(`t.next_inspection IS NOT NULL AND t.next_inspection <= now() + interval '30 days'`);
  if (q.nearEol) where.push(`t.eol_date IS NOT NULL AND t.eol_date <= now() + interval '90 days'`);

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 25));
  const sortCol = ['asset_no', 'name', 'purchase_cost', 'current_book_value', 'status', 'condition', 'created_at', 'purchase_date'].includes(q.sortBy ?? '') ? q.sortBy : 't.id';
  const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';

  const base = `
    FROM asset_register t
    LEFT JOIN users cu ON cu.id = t.custodian_user_id
    LEFT JOIN asset_locations al ON al.id = t.location_id
    LEFT JOIN asset_categories ac ON ac.id = t.category_id
    LEFT JOIN asset_types aty ON aty.id = t.type_id
    WHERE ${where.join(' AND ')}`;
  const countRes = await client.query(`SELECT count(*)::int AS n ${base}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const rowsRes = await client.query(
    `SELECT t.*, cu.first_name || ' ' || cu.last_name AS custodian_name,
            al.name AS location_name, ac.name AS category_name, aty.name AS type_name
     ${base}
     ORDER BY ${sortCol} ${sortDir}, t.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rowsRes.rows, total: Number(countRes.rows[0].n), page, pageSize };
}

export async function dashboardKpis(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT
       count(*) FILTER (WHERE NOT is_deleted) AS total,
       count(*) FILTER (WHERE NOT is_deleted AND status NOT IN ('DRAFT','PENDING_APPROVAL','DISPOSED','RETIRED','ARCHIVED')) AS active,
       count(*) FILTER (WHERE NOT is_deleted AND status IN ('ASSIGNED','IN_USE')) AS assigned,
       count(*) FILTER (WHERE NOT is_deleted AND custody_status = 'UNASSIGNED' AND status NOT IN ('DISPOSED','RETIRED','ARCHIVED')) AS unassigned,
       count(*) FILTER (WHERE NOT is_deleted AND status IN ('IN_STORE','REGISTERED')) AS in_store,
       count(*) FILTER (WHERE NOT is_deleted AND status = 'UNDER_MAINTENANCE') AS under_maintenance,
       count(*) FILTER (WHERE NOT is_deleted AND status = 'MISSING') AS missing,
       count(*) FILTER (WHERE NOT is_deleted AND status IN ('LOST','STOLEN')) AS lost,
       count(*) FILTER (WHERE NOT is_deleted AND status = 'DAMAGED') AS damaged,
       count(*) FILTER (WHERE NOT is_deleted AND status = 'DISPOSED') AS disposed,
       count(*) FILTER (WHERE NOT is_deleted AND next_maintenance IS NOT NULL AND next_maintenance <= now() + interval '30 days') AS due_maintenance,
       count(*) FILTER (WHERE NOT is_deleted AND next_inspection IS NOT NULL AND next_inspection <= now() + interval '30 days') AS due_inspection,
       count(*) FILTER (WHERE NOT is_deleted AND eol_date IS NOT NULL AND eol_date <= now() + interval '90 days') AS near_eol,
       COALESCE(sum(purchase_cost) FILTER (WHERE NOT is_deleted), 0) AS total_acquisition_cost,
       COALESCE(sum(current_book_value) FILTER (WHERE NOT is_deleted), 0) AS current_book_value,
       COALESCE(sum(accumulated_depreciation) FILTER (WHERE NOT is_deleted), 0) AS accumulated_depreciation
     FROM asset_register
     WHERE company_id = $1 AND tenant_id = $2`,
    [ctx.companyId, ctx.tenantId]
  );
  const kpis = res.rows[0];
  const byCategory = await client.query(
    `SELECT COALESCE(ac.name, 'Uncategorised') AS name, count(*)::int AS count,
            COALESCE(sum(t.current_book_value), 0) AS value
     FROM asset_register t LEFT JOIN asset_categories ac ON ac.id = t.category_id
     WHERE t.company_id = $1 AND t.tenant_id = $2 AND NOT t.is_deleted
     GROUP BY ac.name ORDER BY value DESC LIMIT 12`,
    [ctx.companyId, ctx.tenantId]
  );
  const byLocation = await client.query(
    `SELECT COALESCE(al.name, 'Unknown') AS name, count(*)::int AS count,
            COALESCE(sum(t.current_book_value), 0) AS value
     FROM asset_register t LEFT JOIN asset_locations al ON al.id = t.location_id
     WHERE t.company_id = $1 AND t.tenant_id = $2 AND NOT t.is_deleted
     GROUP BY al.name ORDER BY value DESC LIMIT 12`,
    [ctx.companyId, ctx.tenantId]
  );
  const byStatus = await client.query(
    `SELECT status, count(*)::int AS count
     FROM asset_register WHERE company_id = $1 AND tenant_id = $2 AND NOT is_deleted
     GROUP BY status ORDER BY count DESC`,
    [ctx.companyId, ctx.tenantId]
  );
  return { ...kpis, byCategory: byCategory.rows, byLocation: byLocation.rows, byStatus: byStatus.rows };
}

export async function asset360(client: pg.PoolClient, ctx: Ctx, id: number) {
  const asset = await loadAsset(client, ctx, id);
  const [tags, custody, maintenance, audits, scans, timelineRows, warranties, insurance, docs, photos, comments] = await Promise.all([
    client.query(
      `SELECT t.*, q.code AS qr_code, q.status AS qr_status
       FROM asset_tags t LEFT JOIN qr_codes q ON q.id = t.qr_id
       WHERE t.asset_id = $1 AND t.tenant_id = $2 ORDER BY t.id DESC`,
      [id, ctx.tenantId]
    ),
    client.query(
      `SELECT c.*, u.first_name || ' ' || u.last_name AS custodian_name, d.name AS department_name
       FROM asset_custody c
       LEFT JOIN users u ON u.id = c.custodian_user_id
       LEFT JOIN departments d ON d.id = c.custodian_department_id
       WHERE c.asset_id = $1 AND c.tenant_id = $2 ORDER BY c.id DESC LIMIT 30`,
      [id, ctx.tenantId]
    ),
    client.query(
      `SELECT * FROM asset_maintenance_work_orders WHERE asset_id = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT 10`,
      [id, ctx.tenantId]
    ),
    client.query(
      `SELECT * FROM asset_audits WHERE id IN (SELECT audit_id FROM asset_audit_items WHERE asset_id = $1) ORDER BY id DESC LIMIT 5`,
      [id]
    ),
    client.query(
      `SELECT * FROM asset_scans WHERE asset_id = $1 AND tenant_id = $2 ORDER BY scanned_at DESC LIMIT 10`,
      [id, ctx.tenantId]
    ),
    client.query(
      `SELECT * FROM asset_timeline WHERE asset_id = $1 AND tenant_id = $2 ORDER BY occurred_at DESC LIMIT 25`,
      [id, ctx.tenantId]
    ),
    client.query(`SELECT * FROM asset_warranties WHERE asset_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY end_date DESC`, [id, ctx.tenantId]),
    client.query(`SELECT * FROM asset_insurance WHERE asset_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY end_date DESC`, [id, ctx.tenantId]),
    client.query(
      `SELECT d.* FROM asset_documents ad JOIN documents d ON d.id = ad.document_id
       WHERE ad.asset_id = $1 AND ad.tenant_id = $2 ORDER BY ad.id DESC`,
      [id, ctx.tenantId]
    ),
    client.query(`SELECT * FROM asset_photos WHERE asset_id = $1 AND tenant_id = $2 ORDER BY id DESC`, [id, ctx.tenantId]),
    client.query(`SELECT * FROM asset_comments WHERE asset_id = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT 20`, [id, ctx.tenantId]),
  ]);
  const currentCustody = custody.rows.find((r) => r.is_current) ?? custody.rows[0] ?? null;
  return {
    asset,
    tags: tags.rows,
    custody: custody.rows,
    currentCustody,
    maintenance: maintenance.rows,
    audits: audits.rows,
    recentScans: scans.rows,
    timeline: timelineRows.rows,
    warranties: warranties.rows,
    insurance: insurance.rows,
    documents: docs.rows,
    photos: photos.rows,
    comments: comments.rows,
  };
}

// ------------------------------------------------------------
// Registration
// ------------------------------------------------------------

export async function createAsset(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  if (!s(b.name)) throw badRequest('Asset name is required');
  const branchId = n(b.branchId) ?? ctx.branchId ?? null;
  const categoryId = n(b.categoryId);
  const noRes = await client.query('SELECT next_asset_no($1,$2,$3,$4) AS asset_no', [ctx.tenantId, companyId, branchId, categoryId]);
  const assetNo = String(noRes.rows[0].asset_no);
  const purchaseCost = num0(b.purchaseCost);
  const usefulLife = n(b.usefulLifeMonths);
  const ins = await client.query(
    `INSERT INTO asset_register
       (company_id, tenant_id, branch_id, asset_no, name, category_id, type_id, class_id, description,
        manufacturer, model, serial_no, part_no, sku, barcode, is_machine, machine_ref, is_high_value, is_serialized,
        department_id, cost_centre_id, project_id, location_id, warehouse_id, floor, room, building,
        purchase_cost, currency, purchase_date, supplier_id, po_id, po_number, invoice_id, invoice_number, grn_id, grn_number,
        capitalization_date, useful_life_months, residual_value, depreciation_method,
        accumulated_depreciation, current_book_value, status, condition, operational_state, attributes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48)
     RETURNING id`,
    [
      companyId, ctx.tenantId, branchId, assetNo, s(b.name), categoryId, n(b.typeId), n(b.classId), s(b.description),
      s(b.manufacturer), s(b.model), s(b.serialNo), s(b.partNo), s(b.sku), s(b.barcode),
      b.isMachine === true || b.isMachine === 'true', s(b.machineRef), b.isHighValue === true || b.isHighValue === 'true',
      b.isSerialized === false || b.isSerialized === 'false' ? false : true,
      n(b.departmentId), n(b.costCentreId), n(b.projectId), n(b.locationId), n(b.warehouseId), s(b.floor), s(b.room), s(b.building),
      purchaseCost, s(b.currency) ?? 'UGX', s(b.purchaseDate), n(b.supplierId), n(b.poId), s(b.poNumber),
      n(b.invoiceId), s(b.invoiceNumber), n(b.grnId), s(b.grnNumber),
      s(b.capitalizationDate), usefulLife, num0(b.residualValue), s(b.depreciationMethod) ?? 'STRAIGHT_LINE',
      0, purchaseCost, 'DRAFT', s(b.condition) ?? 'NEW', s(b.operationalState) ?? 'NOT_IN_USE',
      JSON.stringify(b.attributes ?? {}), ctx.userId ?? null,
    ]
  );
  const assetId = Number(ins.rows[0].id);
  const qrs = await generateQr(client, ctx, { entityType: 'ASSET', entityId: assetId });
  const qr = qrs[0];
  await client.query('UPDATE asset_register SET qr_id = $1 WHERE id = $2', [qr.id, assetId]);
  const tagNo = await nextNo(client, ctx, 'TAG');
  const tagRes = await client.query(
    `INSERT INTO asset_tags (company_id, tenant_id, asset_id, qr_id, tag_no, tag_type, status, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7) RETURNING id`,
    [companyId, ctx.tenantId, assetId, qr.id, tagNo, s(b.tagType) ?? 'QR', ctx.userId ?? null]
  );
  const tagId = Number(tagRes.rows[0].id);
  await timeline(client, ctx, assetId, {
    eventType: 'REGISTERED', title: 'Asset registered',
    newValue: assetNo, metadata: { qrId: qr.id, tagId },
  });
  await logAudit(client, ctx, { action: 'create', resource: 'assets', recordId: assetId, recordCode: assetNo, newValues: { name: s(b.name) } });
  await emitEvent(client, ctx, {
    eventType: 'asset.registered', entityType: 'assets.register', entityId: assetId, entityCode: assetNo,
    payload: { qrId: qr.id },
  });
  return { assetId, assetNo, qrId: Number(qr.id), qrCode: qr.code, tagId, status: 'DRAFT' };
}

const IDENT_FIELDS = new Set(['name','category_id','type_id','class_id','description','manufacturer','model','serial_no','part_no','sku','barcode','is_machine','machine_ref','is_high_value','is_serialized','attributes']);
const ORG_FIELDS = new Set(['department_id','cost_centre_id','project_id','location_id','warehouse_id','floor','room','building','branch_id']);
const FIN_DRAFT_FIELDS = new Set(['purchase_cost','currency','purchase_date','supplier_id','po_id','po_number','invoice_id','invoice_number','grn_id','grn_number','capitalization_date','useful_life_months','residual_value','depreciation_method']);
const OPS_FIELDS = new Set(['condition','operational_state','expected_return_date','eol_date']);

const FIN_CAMEL: Record<string, string> = {
  purchaseCost: 'purchase_cost', currency: 'currency', purchaseDate: 'purchase_date', supplierId: 'supplier_id',
  poId: 'po_id', poNumber: 'po_number', invoiceId: 'invoice_id', invoiceNumber: 'invoice_number',
  grnId: 'grn_id', grnNumber: 'grn_number', capitalizationDate: 'capitalization_date',
  usefulLifeMonths: 'useful_life_months', residualValue: 'residual_value', depreciationMethod: 'depreciation_method',
};
const ORG_CAMEL: Record<string, string> = {
  departmentId: 'department_id', costCentreId: 'cost_centre_id', projectId: 'project_id', locationId: 'location_id',
  warehouseId: 'warehouse_id', floor: 'floor', room: 'room', building: 'building', branchId: 'branch_id',
};
const IDENT_CAMEL: Record<string, string> = {
  name: 'name', categoryId: 'category_id', typeId: 'type_id', classId: 'class_id', description: 'description',
  manufacturer: 'manufacturer', model: 'model', serialNo: 'serial_no', partNo: 'part_no', sku: 'sku', barcode: 'barcode',
  isMachine: 'is_machine', machineRef: 'machine_ref', isHighValue: 'is_high_value', isSerialized: 'is_serialized', attributes: 'attributes',
};

export async function updateAsset(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };
  for (const [camel, col] of Object.entries(IDENT_CAMEL)) {
    if (camel in b) push(col, IDENT_FIELDS.has(col) && (col === 'attributes' || col === 'description') ? b[camel] : col === 'is_machine' || col === 'is_high_value' || col === 'is_serialized' ? (b[camel] === true || b[camel] === 'true') : s(b[camel]));
  }
  for (const [camel, col] of Object.entries(ORG_CAMEL)) {
    if (camel in b) push(col, n(b[camel]));
  }
  for (const [camel, col] of Object.entries(FIN_CAMEL)) {
    if (camel in b) {
      if (asset.status !== 'DRAFT') {
        throw badRequest('Financial fields can only be changed on a draft asset or through finance workflows');
      }
      push(col, col === 'purchase_cost' || col === 'residual_value' ? num0(b[camel]) : col === 'useful_life_months' ? n(b[camel]) : s(b[camel]));
    }
  }
  for (const [camel, col] of Object.entries({ condition: 'condition', operationalState: 'operational_state', expectedReturnDate: 'expected_return_date', eolDate: 'eol_date' })) {
    if (camel in b) push(col, col === 'condition' ? String(b[camel]).toUpperCase() : s(b[camel]));
  }
  if (sets.length === 0) return { id, changed: 0 };
  if ('purchase_cost' in changes && asset.status === 'DRAFT') {
    push('current_book_value', num0(changes.purchase_cost) - num0(asset.accumulated_depreciation));
  }
  params.push(id);
  await client.query(`UPDATE asset_register SET ${sets.join(', ')}, updated_by = $${params.length + 1} WHERE id = $${params.length}`, [...params, ctx.userId ?? null]);
  await timeline(client, ctx, id, {
    eventType: 'UPDATED', title: 'Asset record updated',
    oldValue: asset.asset_no, newValue: asset.asset_no, metadata: { changes },
  });
  await logAudit(client, ctx, { action: 'update', resource: 'assets', recordId: id, recordCode: asset.asset_no, newValues: changes });
  return { id, changed: sets.length, changes };
}

export async function submitAsset(client: pg.PoolClient, ctx: Ctx, id: number) {
  const asset = await loadAsset(client, ctx, id);
  if (asset.status !== 'DRAFT') throw badRequest('Only draft assets can be submitted for approval');
  await client.query(`UPDATE asset_register SET status = 'PENDING_APPROVAL' WHERE id = $1`, [id]);
  await timeline(client, ctx, id, { eventType: 'SUBMITTED', title: 'Asset submitted for approval', oldValue: 'DRAFT', newValue: 'PENDING_APPROVAL' });
  await logAudit(client, ctx, { action: 'submit', resource: 'assets', recordId: id, recordCode: asset.asset_no, newValues: { status: 'PENDING_APPROVAL' } });
  await startWorkflow(client, ctx, {
    entityType: 'assets.register', entityId: id, entityCode: asset.asset_no,
    amount: num0(asset.purchase_cost), companyId: asset.company_id, branchId: asset.branch_id,
  });
  return { id, status: 'PENDING_APPROVAL' };
}

export async function capitalizeAsset(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, id);
  if (!['REGISTERED', 'AVAILABLE', 'IN_STORE', 'PENDING_APPROVAL'].includes(asset.status)) {
    throw badRequest(`Cannot capitalize an asset with status ${asset.status}`);
  }
  const capDate = s(b.capitalizationDate) ?? s(asset.purchase_date) ?? new Date().toISOString().slice(0, 10);
  await client.query(
    `UPDATE asset_register SET capitalized = true, capitalization_date = $1, gl_journal_id = COALESCE(gl_journal_id, $2), updated_by = $3 WHERE id = $4`,
    [capDate, n(b.glJournalId), ctx.userId ?? null, id]
  );
  await timeline(client, ctx, id, { eventType: 'CAPITALIZED', title: 'Asset capitalized', newValue: capDate, metadata: { glJournalId: n(b.glJournalId) } });
  await logAudit(client, ctx, { action: 'capitalize', resource: 'assets', recordId: id, recordCode: asset.asset_no, newValues: { capitalization_date: capDate } });
  await notifyRoleAdvanced(client, ctx, ['asset_finance'], {
    type: 'ASSET_CAPITALIZED', title: 'Asset capitalized', body: `${asset.asset_no} was capitalized`,
    entityType: 'assets.register', entityId: id, severity: 'INFO',
  });
  return { id, capitalized: true, capitalizationDate: capDate };
}

// ------------------------------------------------------------
// Tagging
// ------------------------------------------------------------

export async function generateTag(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const existing = await client.query(
    `SELECT * FROM asset_tags WHERE asset_id = $1 AND status IN ('PENDING','PRINTED','ASSIGNED','ACTIVE') ORDER BY id DESC LIMIT 1`,
    [assetId]
  );
  if (existing.rows.length > 0 && !(b.force === true || b.force === 'true')) {
    return { tagId: Number(existing.rows[0].id), tagNo: existing.rows[0].tag_no, reuse: true, status: existing.rows[0].status };
  }
  const qrs = await generateQr(client, ctx, { entityType: 'ASSET', entityId: assetId });
  const qr = qrs[0];
  const tagNo = await nextNo(client, ctx, 'TAG');
  const tagRes = await client.query(
    `INSERT INTO asset_tags (company_id, tenant_id, asset_id, qr_id, tag_no, tag_type, status, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7) RETURNING id`,
    [ctx.companyId, ctx.tenantId, assetId, qr.id, tagNo, s(b.tagType) ?? 'QR', ctx.userId ?? null]
  );
  const tagId = Number(tagRes.rows[0].id);
  await client.query('UPDATE asset_register SET qr_id = $1 WHERE id = $2', [qr.id, assetId]);
  await client.query(
    `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by)
     VALUES ($1,$2,$3,'GENERATED',NULL,'PENDING',$4)`,
    [ctx.companyId, ctx.tenantId, tagId, ctx.userId ?? null]
  );
  await timeline(client, ctx, assetId, { eventType: 'TAG_GENERATED', title: 'Asset tag generated', metadata: { tagId, qrId: qr.id } });
  await logAudit(client, ctx, { action: 'generate_tag', resource: 'assets.tags', recordId: tagId, recordCode: asset.asset_no, metadata: { qrId: qr.id } });
  return { tagId, tagNo, qrId: Number(qr.id), qrCode: qr.code, status: 'PENDING' };
}

export async function generateBulkTags(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const assetIds = Array.isArray(b.assetIds) ? b.assetIds.map(Number).filter((x) => Number.isFinite(x)) : [];
  if (assetIds.length === 0) throw badRequest('assetIds are required');
  if (assetIds.length > 1000) throw badRequest('Maximum 1000 tags per bulk operation');
  const out: Record<string, unknown>[] = [];
  for (const assetId of assetIds) {
    const r = await generateTag(client, ctx, assetId, { tagType: s(b.tagType) ?? 'QR' });
    out.push({ assetId, ...r });
  }
  return { generated: out.length, tags: out };
}

export async function printTags(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const assetIds = Array.isArray(b.assetIds) ? b.assetIds.map(Number).filter((x) => Number.isFinite(x)) : [];
  if (assetIds.length === 0) throw badRequest('assetIds are required');
  const templateId = n(b.templateId) ?? 5; // LT-ASSET
  const printer = s(b.printer);
  const reprintReason = s(b.reprintReason);
  const jobNo = await nextNo(client, ctx, 'TAGJOB');
  const jobRes = await client.query(
    `INSERT INTO asset_tag_print_jobs (company_id, tenant_id, job_no, template_id, asset_ids, quantity, printer, status, reprint_reason, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.companyId, ctx.tenantId, jobNo, templateId, JSON.stringify(assetIds), assetIds.length, printer, 'PRINTED', reprintReason, ctx.userId ?? null]
  );
  const jobId = Number(jobRes.rows[0].id);
  for (const assetId of assetIds) {
    const tags = await client.query(
      `SELECT * FROM asset_tags WHERE asset_id = $1 AND status IN ('PENDING','PRINTED','ACTIVE','ASSIGNED') ORDER BY id DESC LIMIT 1`,
      [assetId]
    );
    if (tags.rows.length === 0) continue;
    const tag = tags.rows[0];
    await client.query(
      `UPDATE asset_tags SET status = 'PRINTED', print_job_id = $1, printed_at = now(), printed_by = $2 WHERE id = $3`,
      [jobId, ctx.userId ?? null, tag.id]
    );
    await client.query(
      `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by, reason)
       VALUES ($1,$2,$3,'PRINTED',COALESCE($4,'PENDING'),'PRINTED',$5,$6)`,
      [ctx.companyId, ctx.tenantId, tag.id, tag.status, ctx.userId ?? null, reprintReason ?? null]
    );
    await timeline(client, ctx, assetId, { eventType: 'TAG_PRINTED', title: 'Asset tag printed', metadata: { jobId, tagId: tag.id } });
  }
  await logAudit(client, ctx, { action: 'print_tags', resource: 'assets.tags', recordId: jobId, recordCode: jobNo, metadata: { assetIds, printer } });
  return { jobId, jobNo, quantity: assetIds.length, status: 'PRINTED' };
}

export async function listTagPrintJobs(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, Number(q.pageSize) || 25));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'tenant_id = $1 AND company_id = $2';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND status = $${params.length}`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT p.*, u.first_name || ' ' || u.last_name AS requested_by_name, lt.name AS template_name
     FROM asset_tag_print_jobs p
     LEFT JOIN users u ON u.id = p.requested_by
     LEFT JOIN label_templates lt ON lt.id = p.template_id
     WHERE ${where} ORDER BY p.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function getTagPrintJob(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT p.*, u.first_name || ' ' || u.last_name AS requested_by_name, lt.name AS template_name
     FROM asset_tag_print_jobs p
     LEFT JOIN users u ON u.id = p.requested_by
     LEFT JOIN label_templates lt ON lt.id = p.template_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Print job not found');
  return res.rows[0];
}

export async function replaceTag(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const reason = s(b.reason) ?? 'Tag replacement';
  const oldTags = await client.query(
    `SELECT * FROM asset_tags WHERE asset_id = $1 AND status IN ('PENDING','PRINTED','ASSIGNED','ACTIVE','DAMAGED') ORDER BY id DESC LIMIT 1`,
    [assetId]
  );
  const oldTag = oldTags.rows[0] ?? null;
  if (oldTag) {
    await client.query(
      `UPDATE asset_tags SET status = 'REPLACED', status_reason = $1, voided_at = now(), voided_by = $2 WHERE id = $3`,
      [reason, ctx.userId ?? null, oldTag.id]
    );
    await client.query(
      `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by, reason)
       VALUES ($1,$2,$3,'REPLACED',$4,'REPLACED',$5,$6)`,
      [ctx.companyId, ctx.tenantId, oldTag.id, oldTag.status, ctx.userId ?? null, reason]
    );
    await voidQr(client, ctx, oldTag.qr_id, reason);
  }
  const qrs = await generateQr(client, ctx, { entityType: 'ASSET', entityId: assetId });
  const qr = qrs[0];
  const tagNo = await nextNo(client, ctx, 'TAG');
  const tagRes = await client.query(
    `INSERT INTO asset_tags (company_id, tenant_id, asset_id, qr_id, tag_no, tag_type, status, replacement_of_id, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8) RETURNING id`,
    [ctx.companyId, ctx.tenantId, assetId, qr.id, tagNo, s(b.tagType) ?? 'QR', oldTag ? oldTag.id : null, ctx.userId ?? null]
  );
  const tagId = Number(tagRes.rows[0].id);
  await client.query('UPDATE asset_register SET qr_id = $1 WHERE id = $2', [qr.id, assetId]);
  await client.query(
    `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by, reason)
     VALUES ($1,$2,$3,'REPLACEMENT_GENERATED',NULL,'PENDING',$4,$5)`,
    [ctx.companyId, ctx.tenantId, tagId, ctx.userId ?? null, reason]
  );
  await timeline(client, ctx, assetId, { eventType: 'TAG_REPLACED', title: 'Asset tag replaced', reason, metadata: { oldTagId: oldTag ? oldTag.id : null, newTagId: tagId } });
  await logAudit(client, ctx, { action: 'replace_tag', resource: 'assets.tags', recordId: tagId, recordCode: asset.asset_no, metadata: { oldTagId: oldTag ? oldTag.id : null, reason } });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_officer'], {
    type: 'TAG_REPLACED', title: 'Tag replaced', body: `${asset.asset_no} received a replacement tag`,
    entityType: 'assets.register', entityId: assetId, severity: 'INFO',
  });
  return { tagId, tagNo, qrId: Number(qr.id), qrCode: qr.code, replacementOfId: oldTag ? Number(oldTag.id) : null, status: 'PENDING' };
}

export async function voidTag(client: pg.PoolClient, ctx: Ctx, tagId: number, b: Record<string, unknown>) {
  const reason = s(b.reason) ?? 'Tag voided';
  const res = await client.query(
    `UPDATE asset_tags SET status = 'VOID', void_reason = $1, voided_at = now(), voided_by = $2, status_reason = $1
     WHERE id = $3 AND tenant_id = $4 AND status <> 'VOID' RETURNING *`,
    [reason, ctx.userId ?? null, tagId, ctx.tenantId]
  );
  if (res.rows.length === 0) {
    const existing = await client.query('SELECT * FROM asset_tags WHERE id = $1 AND tenant_id = $2', [tagId, ctx.tenantId]);
    if (existing.rows.length === 0) throw notFound('Asset tag not found');
    throw badRequest('A voided or replaced tag cannot be reactivated or re-voided');
  }
  const tag = res.rows[0];
  await client.query(
    `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by, reason)
     VALUES ($1,$2,$3,'VOIDED',$4,'VOID',$5,$6)`,
    [ctx.companyId, ctx.tenantId, tagId, tag.status, ctx.userId ?? null, reason]
  );
  await voidQr(client, ctx, tag.qr_id, reason);
  await timeline(client, ctx, tag.asset_id, { eventType: 'TAG_VOIDED', title: 'Asset tag voided', reason, metadata: { tagId } });
  await logAudit(client, ctx, { action: 'void_tag', resource: 'assets.tags', recordId: tagId, metadata: { reason } });
  return { tagId, status: 'VOID' };
}

export async function attachTag(client: pg.PoolClient, ctx: Ctx, tagId: number) {
  const res = await client.query(
    `UPDATE asset_tags SET status = 'ASSIGNED', attached_at = now(), attached_by = $1
     WHERE id = $2 AND tenant_id = $3 AND status IN ('PENDING','PRINTED') RETURNING *`,
    [ctx.userId ?? null, tagId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset tag not found or not in an attachable state');
  const tag = res.rows[0];
  await client.query(
    `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by)
     VALUES ($1,$2,$3,'ATTACHED',$4,'ASSIGNED',$5)`,
    [ctx.companyId, ctx.tenantId, tagId, tag.status, ctx.userId ?? null]
  );
  await timeline(client, ctx, tag.asset_id, { eventType: 'TAG_ATTACHED', title: 'Asset tag attached', metadata: { tagId } });
  return { tagId, status: 'ASSIGNED' };
}

export async function verifyTag(client: pg.PoolClient, ctx: Ctx, tagId: number) {
  const res = await client.query(
    `UPDATE asset_tags SET status = 'ACTIVE', verified_at = now(), verified_by = $1
     WHERE id = $2 AND tenant_id = $3 AND status IN ('PENDING','PRINTED','ASSIGNED') RETURNING *`,
    [ctx.userId ?? null, tagId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset tag not found or not in a verifiable state');
  const tag = res.rows[0];
  await client.query(
    `UPDATE asset_register SET last_verified_at = now(), last_verified_by = $1 WHERE id = $2`,
    [ctx.userId ?? null, tag.asset_id]
  );
  await client.query(
    `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by)
     VALUES ($1,$2,$3,'VERIFIED',$4,'ACTIVE',$5)`,
    [ctx.companyId, ctx.tenantId, tagId, tag.status, ctx.userId ?? null]
  );
  await timeline(client, ctx, tag.asset_id, { eventType: 'TAG_VERIFIED', title: 'Asset tag verified', metadata: { tagId } });
  return { tagId, status: 'ACTIVE', verifiedAt: new Date().toISOString() };
}

export async function listTags(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 't.tenant_id = $1 AND t.company_id = $2';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND t.status = $${params.length}`; }
  if (q.assetId) { params.push(Number(q.assetId)); where += ` AND t.asset_id = $${params.length}`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT t.*, a.asset_no, a.name AS asset_name, q.code AS qr_code
     FROM asset_tags t
     JOIN asset_register a ON a.id = t.asset_id
     LEFT JOIN qr_codes q ON q.id = t.qr_id
     WHERE ${where} ORDER BY t.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function listTagEvents(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'e.tenant_id = $1 AND e.company_id = $2';
  if (q.tagId) { params.push(Number(q.tagId)); where += ` AND e.tag_id = $${params.length}`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT e.*, u.first_name || ' ' || u.last_name AS performed_by_name, t.tag_no, a.asset_no
     FROM asset_tag_events e
     JOIN asset_tags t ON t.id = e.tag_id
     JOIN asset_register a ON a.id = t.asset_id
     LEFT JOIN users u ON u.id = e.performed_by
     WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

// ------------------------------------------------------------
// Scanning
// ------------------------------------------------------------

const SCAN_TYPE_FROM_ACTION: Record<string, string> = {
  IDENTIFY: 'IDENTIFY', VERIFY: 'VERIFY', ASSIGN: 'ASSIGN', TRANSFER: 'TRANSFER', INSPECT: 'INSPECT',
  AUDIT: 'AUDIT', MAINTAIN: 'MAINTAIN', CHECKIN: 'CHECKIN', CHECKOUT: 'CHECKOUT', REPORT_DAMAGE: 'REPORT_DAMAGE',
  REPORT_MISSING: 'REPORT_MISSING', DISPOSE: 'DISPOSE', TRACK: 'TRACK',
};

export async function scanAsset(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const code = s(b.code);
  if (!code) throw badRequest('QR code is required');
  const qr = await findQrByCode(client, ctx, code);
  if (!qr) throw notFound('QR code not found');
  const qrRes = await client.query('SELECT * FROM qr_codes WHERE id = $1', [qr.id]);
  const qrRow = qrRes.rows[0];
  if (b.secret) {
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(String(b.secret)).digest('hex') !== qrRow.secret_hash) {
      throw badRequest('Invalid QR secret');
    }
  }
  const assetRes = await client.query(
    `SELECT a.*, al.name AS location_name,
            u.first_name || ' ' || u.last_name AS custodian_name,
            ac.name AS category_name
     FROM asset_register a
     LEFT JOIN asset_locations al ON al.id = a.location_id
     LEFT JOIN users u ON u.id = a.custodian_user_id
     LEFT JOIN asset_categories ac ON ac.id = a.category_id
     WHERE a.qr_id = $1 AND a.tenant_id = $2`,
    [qr.id, ctx.tenantId]
  );
  if (assetRes.rows.length === 0) throw notFound('No asset is bound to this QR code');
  const asset = assetRes.rows[0];
  const tagRes = await client.query(
    `SELECT * FROM asset_tags WHERE qr_id = $1 ORDER BY id DESC LIMIT 1`,
    [qr.id]
  );
  const tag = tagRes.rows[0] ?? null;
  const tagVoid = tag && ['VOID', 'REPLACED'].includes(tag.status);
  const result = tagVoid ? 'VOID' : qrRow.status === 'VOID' || qrRow.status === 'REPLACED' ? 'VOID' : 'AUTHENTIC';
  const action = s(b.action) ?? 'IDENTIFY';
  const scanType = SCAN_TYPE_FROM_ACTION[action.toUpperCase()] ?? 'IDENTIFY';
  const locationId = n(b.locationId) ?? asset.location_id;
  const actual = {
    location_id: locationId,
    custodian_user_id: asset.custodian_user_id,
    status: asset.status,
    condition: asset.condition,
  };
  const scanRes = await client.query(
    `INSERT INTO asset_scans
       (company_id, tenant_id, asset_id, qr_id, tag_id, scan_type, result, location_id, expected_values, actual_values, note, device, scanned_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, asset.id, qr.id, tag ? tag.id : null, scanType, result, locationId,
      JSON.stringify(b.expected ?? {}), JSON.stringify(actual), s(b.note), s(b.device), ctx.userId ?? null,
      JSON.stringify({ action }),
    ]
  );
  const scanId = Number(scanRes.rows[0].id);
  await client.query(
    `UPDATE asset_register SET last_scan_at = now(), last_scan_location_id = $1, last_scan_user_id = $2 WHERE id = $3`,
    [locationId, ctx.userId ?? null, asset.id]
  );
  if (['VERIFY', 'AUDIT', 'CHECKIN', 'CHECKOUT', 'INSPECT'].includes(scanType)) {
    await client.query(`UPDATE asset_register SET last_verified_at = now(), last_verified_by = $1 WHERE id = $2`, [ctx.userId ?? null, asset.id]);
  }
  await client.query('SELECT detect_asset_scan_anomalies($1,$2,$3)', [asset.id, scanId, locationId]);
  await emitEvent(client, ctx, {
    eventType: 'asset.scanned', entityType: 'assets.register', entityId: Number(asset.id),
    entityCode: asset.asset_no, payload: { action, result, scanId, locationId },
  });
  await logAudit(client, ctx, { action: 'scan', resource: 'assets.scans', recordId: scanId, recordCode: asset.asset_no, metadata: { action, result, locationId } });
  return {
    scanId,
    result,
    asset: {
      id: Number(asset.id), assetNo: asset.asset_no, name: asset.name, status: asset.status, condition: asset.condition,
      custodianName: asset.custodian_name, locationName: asset.location_name, locationId: asset.location_id,
      categoryName: asset.category_name, custodyStatus: asset.custody_status, isMachine: asset.is_machine,
      currentBookValue: Number(asset.current_book_value), lastVerifiedAt: asset.last_verified_at,
      lastScanAt: asset.last_scan_at,
    },
    tag: tag ? { tagId: Number(tag.id), tagNo: tag.tag_no, status: tag.status } : null,
    qr: { qrId: Number(qr.id), code: qr.code, status: qrRow.status },
    lastKnown: {
      locationId: asset.last_scan_location_id, scannedBy: asset.last_scan_user_id, scannedAt: asset.last_scan_at,
    },
  };
}

export async function listScans(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 's.tenant_id = $1 AND s.company_id = $2';
  if (q.assetId) { params.push(Number(q.assetId)); where += ` AND s.asset_id = $${params.length}`; }
  if (q.result) { params.push(String(q.result).toUpperCase()); where += ` AND s.result = $${params.length}`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT s.*, a.asset_no, a.name AS asset_name, u.first_name || ' ' || u.last_name AS scanned_by_name
     FROM asset_scans s
     JOIN asset_register a ON a.id = s.asset_id
     LEFT JOIN users u ON u.id = s.scanned_by
     WHERE ${where} ORDER BY s.scanned_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function listAnomalies(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'x.tenant_id = $1 AND x.company_id = $2';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND x.status = $${params.length}`; }
  if (q.assetId) { params.push(Number(q.assetId)); where += ` AND x.asset_id = $${params.length}`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT x.*, a.asset_no, a.name AS asset_name, u.first_name || ' ' || u.last_name AS resolved_by_name
     FROM asset_scan_anomalies x
     JOIN asset_register a ON a.id = x.asset_id
     LEFT JOIN users u ON u.id = x.resolved_by
     WHERE ${where} ORDER BY x.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function resolveAnomaly(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const res = await client.query(
    `UPDATE asset_scan_anomalies SET status = 'RESOLVED', resolution_note = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND tenant_id = $4 AND status <> 'RESOLVED' RETURNING *`,
    [s(b.resolutionNote), ctx.userId ?? null, id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Anomaly not found or already resolved');
  await logAudit(client, ctx, { action: 'resolve_anomaly', resource: 'assets.anomalies', recordId: id, metadata: { resolutionNote: s(b.resolutionNote) } });
  return res.rows[0];
}

// ------------------------------------------------------------
// Workflow approval side-effects
// Called by the workflow service after the final approval step.
// Each finalizes the operational state and, where applicable,
// posts the financial entry. Safe to run in the auto-approve path
// (entity may still be DRAFT/SUBMITTED when the side effect runs).
// ------------------------------------------------------------

/** Transfer approved by workflow: move to PENDING_HANDOVER, log per-asset timeline. */
export async function approveTransfer(client: pg.PoolClient, ctx: Ctx, transferId: number) {
  const res = await client.query(
    'SELECT * FROM asset_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [transferId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset transfer not found');
  const t = res.rows[0];
  if (t.status === 'PENDING_HANDOVER' || t.status === 'COMPLETED') return { transferId, status: t.status };
  if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(t.status)) {
    throw badRequest(`Transfer cannot be approved from status ${t.status}`);
  }
  await client.query(
    `UPDATE asset_transfers SET status = 'PENDING_HANDOVER', updated_by = $2 WHERE id = $1`,
    [transferId, ctx.userId ?? null]
  );
  const items = await client.query(
    `SELECT ti.*, a.asset_no, a.name AS asset_name
     FROM asset_transfer_items ti
     JOIN asset_register a ON a.id = ti.asset_id
     WHERE ti.transfer_id = $1`,
    [transferId]
  );
  for (const it of items.rows) {
    await timeline(client, ctx, Number(it.asset_id), {
      eventType: 'TRANSFER_APPROVED', title: 'Transfer approved',
      description: `Transfer ${t.transfer_no} approved; awaiting handover`,
      oldValue: t.status, newValue: 'PENDING_HANDOVER',
      locationId: n(t.to_location_id),
      reason: s(t.reason),
      metadata: { transferId: Number(t.id), transferNo: t.transfer_no },
    });
  }
  await logAudit(client, ctx, {
    action: 'approve', resource: 'assets.transfers', recordId: transferId,
    recordCode: String(t.transfer_no), newValues: { status: 'PENDING_HANDOVER' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.transfer_approved', entityType: 'assets.transfers',
    entityId: transferId, entityCode: String(t.transfer_no),
    payload: { status: 'PENDING_HANDOVER' },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_storekeeper', 'asset_manager'], {
    type: 'TRANSFER_APPROVED', title: 'Transfer approved',
    body: `Transfer ${t.transfer_no} is approved and awaiting handover`,
    entityType: 'assets.transfers', entityId: transferId, severity: 'INFO',
  });
  return { transferId, status: 'PENDING_HANDOVER' };
}

/** Maintenance work order approved: start work, move asset to UNDER_MAINTENANCE. */
export async function approveMaintenance(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const res = await client.query(
    'SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const wo = res.rows[0];
  if (wo.status === 'IN_PROGRESS' || wo.status === 'COMPLETED') return { workOrderId, status: wo.status };
  if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(wo.status)) {
    throw badRequest(`Work order cannot be approved from status ${wo.status}`);
  }
  await client.query(
    `UPDATE asset_maintenance_work_orders SET status = 'IN_PROGRESS', updated_by = $2 WHERE id = $1`,
    [workOrderId, ctx.userId ?? null]
  );
  const asset = await loadAsset(client, ctx, Number(wo.asset_id));
  if (['REGISTERED', 'IN_STORE', 'AVAILABLE', 'ASSIGNED', 'IN_USE', 'TRANSFERRED', 'DAMAGED', 'QUARANTINED'].includes(asset.status)) {
    await client.query(
      `UPDATE asset_register SET status = 'UNDER_MAINTENANCE', maintenance_status = 'IN_PROGRESS', updated_by = $2 WHERE id = $1`,
      [asset.id, ctx.userId ?? null]
    );
  } else {
    await client.query(
      `UPDATE asset_register SET maintenance_status = 'IN_PROGRESS', updated_by = $2 WHERE id = $1`,
      [asset.id, ctx.userId ?? null]
    );
  }
  await timeline(client, ctx, Number(wo.asset_id), {
    eventType: 'MAINTENANCE_STARTED', title: 'Maintenance work started',
    description: `Work order ${wo.wo_no} approved; work in progress`,
    oldValue: wo.status, newValue: 'IN_PROGRESS',
    metadata: { workOrderId: Number(wo.id), maintenanceType: wo.maintenance_type },
  });
  await logAudit(client, ctx, {
    action: 'approve', resource: 'assets.maintenance', recordId: workOrderId,
    recordCode: String(wo.wo_no), newValues: { status: 'IN_PROGRESS' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.maintenance_started', entityType: 'assets.maintenance',
    entityId: workOrderId, entityCode: String(wo.wo_no),
    payload: { status: 'IN_PROGRESS', assetId: Number(wo.asset_id) },
  });
  return { workOrderId, status: 'IN_PROGRESS' };
}

/** Disposal approved: record dual-control approvals, release custody, void
 *  tag + QR, set asset DISPOSED, post disposal GL. */
export async function approveDisposal(client: pg.PoolClient, ctx: Ctx, disposalId: number) {
  const res = await client.query(
    'SELECT * FROM asset_disposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const d = res.rows[0];
  if (d.status === 'COMPLETED') return { disposalId, status: 'COMPLETED', glJournalId: n(d.gl_journal_id) };
  if (!['DRAFT', 'SUBMITTED', 'VALUATION', 'INSPECTION', 'APPROVED', 'FINANCE_REVIEW'].includes(d.status)) {
    throw badRequest(`Disposal cannot be processed from status ${d.status}`);
  }
  const asset = await loadAsset(client, ctx, Number(d.asset_id));
  const approvedAt = new Date().toISOString();

  const tasks = await client.query(
    `SELECT t.step_seq, t.decided_by, t.decided_at, t.comment
     FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     WHERE i.entity_type = 'assets.disposals' AND i.entity_id = $1 AND t.status = 'APPROVED'
     ORDER BY t.step_seq`,
    [disposalId]
  );
  const approvals = tasks.rows.length ? tasks.rows : [{ step_seq: 1, decided_by: ctx.userId ?? null, decided_at: approvedAt, comment: null }];
  for (const ap of approvals) {
    const level = Math.max(1, Number(ap.step_seq));
    await client.query(
      `INSERT INTO asset_disposal_approvals
         (company_id, tenant_id, disposal_id, approval_level, approved_by, approved_at, decision, comment)
       VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',$7)
       ON CONFLICT (disposal_id, approval_level) DO UPDATE
         SET approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
             decision = 'APPROVED', comment = EXCLUDED.comment`,
      [ctx.companyId, ctx.tenantId, disposalId, level, ap.decided_by ?? ctx.userId ?? null, ap.decided_at ?? approvedAt, ap.comment ?? null]
    );
  }

  const salePrice = n(d.sale_price) ?? n(d.valuation) ?? 0;
  const cost = num0(asset.purchase_cost);
  const accDep = num0(asset.accumulated_depreciation);
  const bookValue = num0(asset.current_book_value);
  const gainLoss = Number((salePrice - bookValue).toFixed(2));

  const catRes = await client.query('SELECT name FROM asset_categories WHERE id = $1', [asset.category_id]);
  const catName = String(catRes.rows[0]?.name ?? '');
  const costAccount = /IT|COMPUTER|LAPTOP|SERVER|PRINTER|MOBILE|NETWORK|PHONE|SCANNER/i.test(catName) ? '1610' : '1600';
  const accDepId = await finance.getAccountId(client, ctx, '1620');
  const costId = await finance.getAccountId(client, ctx, costAccount);
  const glId = await finance.getAccountId(client, ctx, '1690');
  const lines: finance.JournalLine[] = [
    { account_id: accDepId, debit: accDep, description: `Accumulated depreciation - ${asset.asset_no}` },
    { account_id: costId, credit: cost, description: `Asset cost removed - ${asset.asset_no}` },
  ];
  if (salePrice > 0) {
    const bankId = await finance.getAccountId(client, ctx, '1100');
    lines.push({ account_id: bankId, debit: salePrice, description: `Proceeds - ${asset.asset_no}` });
  }
  if (gainLoss > 0) lines.push({ account_id: glId, credit: gainLoss, description: `Gain on disposal - ${asset.asset_no}` });
  if (gainLoss < 0) lines.push({ account_id: glId, debit: Math.abs(gainLoss), description: `Loss on disposal - ${asset.asset_no}` });
  const glJournalId = await finance.postJournalLines(client, ctx, {
    entryDate: s(d.disposal_date) ?? new Date().toISOString().slice(0, 10),
    journalType: 'ASSET_DISPOSAL',
    description: `Disposal ${d.disposal_no} - ${asset.asset_no}`,
    lines,
    refType: 'asset_disposals',
    refId: disposalId,
    refCode: String(d.disposal_no),
  });

  await client.query(
    `UPDATE asset_custody SET is_current = false, released_at = now()
     WHERE asset_id = $1 AND is_current = true`,
    [asset.id]
  );
  await client.query(
    `UPDATE asset_register
        SET status = 'DISPOSED', condition = 'DISPOSED', custody_status = 'UNASSIGNED',
            custodian_user_id = NULL, custodian_employee_id = NULL, custodian_department_id = NULL,
            assigned_date = NULL, expected_return_date = NULL,
            maintenance_status = 'NONE', operational_state = 'DECOMMISSIONED',
            gl_journal_id = $2, updated_by = $3
      WHERE id = $1`,
    [asset.id, glJournalId, ctx.userId ?? null]
  );
  const tagRes = await client.query(
    `SELECT id, qr_id FROM asset_tags
     WHERE asset_id = $1 AND status IN ('PENDING','PRINTED','ASSIGNED','ACTIVE')
     ORDER BY id DESC`,
    [asset.id]
  );
  for (const tag of tagRes.rows) {
    await client.query(
      `UPDATE asset_tags SET status = 'VOID', updated_by = $2 WHERE id = $1`,
      [tag.id, ctx.userId ?? null]
    );
    await client.query(
      `INSERT INTO asset_tag_events (company_id, tenant_id, tag_id, event_type, previous_status, new_status, performed_by, reason)
       VALUES ($1,$2,$3,'VOIDED','ACTIVE','VOID',$4,'Asset disposed')`,
      [ctx.companyId, ctx.tenantId, tag.id, ctx.userId ?? null]
    );
    if (tag.qr_id) await voidQr(client, ctx, Number(tag.qr_id), 'Asset disposed');
  }
  await client.query(
    `UPDATE asset_disposals
        SET status = 'COMPLETED', approved_by = COALESCE(approved_by, $2), approved_at = COALESCE(approved_at, now()),
            gain_loss = $3, gl_journal_id = $4, disposal_date = COALESCE(disposal_date, CURRENT_DATE),
            updated_by = $2
      WHERE id = $1`,
    [disposalId, ctx.userId ?? null, gainLoss, glJournalId]
  );
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'DISPOSED', title: 'Asset disposed',
    description: `Disposal ${d.disposal_no} completed (${d.method})`,
    oldValue: asset.status, newValue: 'DISPOSED',
    reason: s(d.notes) ?? s(d.reason), metadata: { disposalId: Number(d.id), gainLoss, glJournalId },
  });
  await logAudit(client, ctx, {
    action: 'approve_disposal', resource: 'assets.disposals', recordId: disposalId,
    recordCode: String(d.disposal_no),
    newValues: { status: 'COMPLETED', gain_loss: gainLoss, gl_journal_id: glJournalId },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.disposal_completed', entityType: 'assets.disposals',
    entityId: disposalId, entityCode: String(d.disposal_no),
    payload: { assetId: Number(asset.id), glJournalId, gainLoss },
  });
  return { disposalId, status: 'COMPLETED', glJournalId, gainLoss };
}

/** Impairment approved: apply book value, adjust accumulated depreciation,
 *  post GL (Dr 6500 / Cr 1620; reversed for reversals). Revaluation: book
 *  value only. */
export async function approveImpairment(client: pg.PoolClient, ctx: Ctx, impairmentId: number) {
  const res = await client.query(
    'SELECT * FROM asset_impairments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [impairmentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset impairment not found');
  const imp = res.rows[0];
  if (imp.status === 'POSTED') return { impairmentId, status: 'POSTED', glJournalId: n(imp.gl_journal_id) };
  if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(imp.status)) {
    throw badRequest(`Impairment cannot be posted from status ${imp.status}`);
  }
  const asset = await loadAsset(client, ctx, Number(imp.asset_id));
  const oldBook = num0(imp.old_book_value);
  const newBook = num0(imp.new_book_value);
  const delta = Number((oldBook - newBook).toFixed(2)); // >0 impairment, <0 reversal
  let glJournalId: number | null = null;

  if (imp.impairment_type === 'REVALUATION') {
    await client.query(
      `UPDATE asset_register SET current_book_value = $1, updated_by = $2 WHERE id = $3`,
      [newBook, ctx.userId ?? null, asset.id]
    );
  } else {
    const newAccDep = Number((num0(asset.accumulated_depreciation) + delta).toFixed(2));
    await client.query(
      `UPDATE asset_register SET current_book_value = $1, accumulated_depreciation = $2, updated_by = $3 WHERE id = $4`,
      [newBook, newAccDep, ctx.userId ?? null, asset.id]
    );
    if (delta !== 0) {
      const expId = await finance.getAccountId(client, ctx, '6500');
      const accDepId = await finance.getAccountId(client, ctx, '1620');
      const lines: finance.JournalLine[] = delta > 0
        ? [
            { account_id: expId, debit: Math.abs(delta), description: `Impairment - ${asset.asset_no}` },
            { account_id: accDepId, credit: Math.abs(delta), description: `Impairment - ${asset.asset_no}` },
          ]
        : [
            { account_id: accDepId, debit: Math.abs(delta), description: `Impairment reversal - ${asset.asset_no}` },
            { account_id: expId, credit: Math.abs(delta), description: `Impairment reversal - ${asset.asset_no}` },
          ];
      glJournalId = await finance.postJournalLines(client, ctx, {
        entryDate: new Date().toISOString().slice(0, 10),
        journalType: 'ASSET_IMPAIRMENT',
        description: `Impairment ${imp.impairment_no} - ${asset.asset_no}`,
        lines,
        refType: 'asset_impairments',
        refId: impairmentId,
        refCode: String(imp.impairment_no),
      });
    }
  }
  await client.query(
    `UPDATE asset_impairments SET status = 'POSTED', gl_journal_id = $2, updated_by = $3 WHERE id = $1`,
    [impairmentId, glJournalId, ctx.userId ?? null]
  );
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'IMPAIRED', title: 'Asset book value adjusted',
    description: `${imp.impairment_type} ${imp.impairment_no} posted`,
    oldValue: String(oldBook), newValue: String(newBook),
    metadata: { impairmentId: Number(imp.id), glJournalId },
  });
  await logAudit(client, ctx, {
    action: 'post_impairment', resource: 'assets.impairments', recordId: impairmentId,
    recordCode: String(imp.impairment_no),
    newValues: { status: 'POSTED', old_book_value: oldBook, new_book_value: newBook, gl_journal_id: glJournalId },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.impairment_posted', entityType: 'assets.impairments',
    entityId: impairmentId, entityCode: String(imp.impairment_no),
    payload: { assetId: Number(asset.id), oldBook, newBook, glJournalId },
  });
  return { impairmentId, status: 'POSTED', glJournalId };
}

// ============================================================
// Lifecycle: timeline, movement map, custody & assignments
// ============================================================

export async function getAssetTimeline(
  client: pg.PoolClient,
  ctx: Ctx,
  assetId: number,
  q: Record<string, unknown> = {}
) {
  const asset = await loadAsset(client, ctx, assetId);
  const limit = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [assetId, ctx.tenantId];
  let where = 't.asset_id = $1 AND t.tenant_id = $2';
  if (q.eventType) {
    params.push(String(q.eventType));
    where += ` AND t.event_type = $${params.length}`;
  }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT t.*, u.first_name || ' ' || u.last_name AS user_name,
            al.name AS location_name
     FROM asset_timeline t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN asset_locations al ON al.id = t.location_id
     WHERE ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { assetId: Number(asset.id), assetNo: asset.asset_no, rows: rows.rows };
}

/** Visual movement history for an asset (From -> To chain, who/when/why). */
export async function assetMovementMap(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const asset = await loadAsset(client, ctx, assetId);
  const rows = await client.query(
    `SELECT t.*, u.first_name || ' ' || u.last_name AS user_name,
            al.name AS location_name
     FROM asset_timeline t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN asset_locations al ON al.id = t.location_id
     WHERE t.asset_id = $1 AND t.tenant_id = $2
       AND (t.location_id IS NOT NULL OR t.event_type IN
         ('REGISTERED','ASSIGNED','RETURNED','TRANSFER_REQUESTED','TRANSFER_APPROVED',
          'TRANSFER_COMPLETED','MOVED','LOCATION_CHANGED','RECEIVED','CHECKIN','CHECKOUT',
          'MISSING_REPORTED','RECOVERED','DISPOSED'))
     ORDER BY t.created_at ASC`,
    [assetId, ctx.tenantId]
  );
  const locRes = await client.query('SELECT name FROM asset_locations WHERE id = $1', [asset.location_id]);
  return {
    assetId: Number(asset.id),
    assetNo: asset.asset_no,
    current: {
      locationId: n(asset.location_id),
      locationName: locRes.rows[0]?.name ?? null,
      custodianUserId: n(asset.custodian_user_id),
      status: asset.status,
      custodyStatus: asset.custody_status,
    },
    movements: rows.rows,
  };
}

const NOT_ASSIGNABLE = new Set(['DISPOSED', 'RETIRED', 'ARCHIVED', 'MISSING', 'LOST', 'STOLEN', 'UNDER_MAINTENANCE', 'UNDER_INSPECTION']);

/** Assign an available asset to an employee, department or branch location. */
export async function assignAsset(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (NOT_ASSIGNABLE.has(asset.status)) {
    throw badRequest(`Asset status ${asset.status} cannot be assigned`);
  }
  const custodianUserId = n(b.custodianUserId);
  const custodianEmployeeId = n(b.custodianEmployeeId);
  const custodianDepartmentId = n(b.custodianDepartmentId);
  if (!custodianUserId && !custodianEmployeeId && !custodianDepartmentId) {
    throw badRequest('A custodian (user, employee or department) is required');
  }
  const locationId = n(b.locationId) ?? asset.location_id;
  if (!locationId) throw badRequest('A location is required for assignment');
  const assignedDate = s(b.assignedDate) ?? new Date().toISOString().slice(0, 10);
  const expectedReturnDate = s(b.expectedReturnDate);
  const inUse = b.inUse === true || b.inUse === 'true';
  const requireAcknowledgement = b.requireAcknowledgement === true || b.requireAcknowledgement === 'true';

  await client.query(
    `UPDATE asset_custody SET is_current = false, released_at = now()
     WHERE asset_id = $1 AND is_current = true`,
    [assetId]
  );
  const ins = await client.query(
    `INSERT INTO asset_custody
       (company_id, tenant_id, asset_id, custodian_user_id, custodian_employee_id, custodian_department_id,
        action, from_user_id, from_department_id, assigned_date, expected_return_date, is_current,
        accepted_at, accepted_by, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'ASSIGN',$7,$8,$9,$10,true,$11,$12,$13,$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, assetId, custodianUserId, custodianEmployeeId, custodianDepartmentId,
      asset.custodian_user_id ?? null, asset.custodian_department_id ?? null,
      assignedDate, expectedReturnDate,
      requireAcknowledgement ? null : new Date().toISOString(),
      requireAcknowledgement ? null : ctx.userId ?? null,
      s(b.reason), ctx.userId ?? null,
    ]
  );
  const assignmentId = Number(ins.rows[0].id);
  const newStatus = inUse ? 'IN_USE' : 'ASSIGNED';
  await client.query(
    `UPDATE asset_register
        SET custodian_user_id = $1, custodian_employee_id = $2, custodian_department_id = $3,
            location_id = $4, assigned_date = $5, expected_return_date = $6,
            custody_status = 'ASSIGNED', status = $7, updated_by = $8
      WHERE id = $9`,
    [custodianUserId, custodianEmployeeId, custodianDepartmentId, locationId, assignedDate, expectedReturnDate, newStatus, ctx.userId ?? null, assetId]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'ASSIGNED', title: 'Asset assigned',
    description: custodianUserId ? 'Assigned to employee custodian' : custodianDepartmentId ? 'Assigned to department' : 'Assigned to branch custodian',
    oldValue: asset.status, newValue: newStatus,
    locationId, reason: s(b.reason),
    metadata: { assignmentId, custodianUserId, custodianDepartmentId, requireAcknowledgement },
  });
  await logAudit(client, ctx, {
    action: 'assign', resource: 'assets.assignments', recordId: assignmentId,
    recordCode: asset.asset_no, newValues: { custodianUserId, custodianDepartmentId, locationId, status: newStatus },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.assigned', entityType: 'assets.register', entityId: assetId,
    entityCode: asset.asset_no, payload: { assignmentId, custodianUserId, locationId },
  });
  if (custodianUserId) {
    await notifyUserAdvanced(client, ctx, custodianUserId, {
      type: 'ASSET_ASSIGNED', title: 'Asset assigned to you',
      body: `${asset.asset_no} (${asset.name}) has been assigned to you`,
      entityType: 'assets.register', entityId: assetId, severity: 'INFO', actionRequired: requireAcknowledgement,
    });
  }
  return { assignmentId, assetId, assetNo: asset.asset_no, status: newStatus, custodyStatus: 'ASSIGNED' };
}

/** Accept (or digitally acknowledge) an existing assignment. */
export async function acceptAssignment(client: pg.PoolClient, ctx: Ctx, custodyId: number) {
  const res = await client.query(
    `UPDATE asset_custody SET accepted_at = COALESCE(accepted_at, now()), accepted_by = $1
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [ctx.userId ?? null, custodyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Assignment not found');
  const c = res.rows[0];
  await timeline(client, ctx, Number(c.asset_id), {
    eventType: 'ASSIGNMENT_ACCEPTED', title: 'Assignment accepted',
    description: 'Custodian accepted the asset assignment', metadata: { custodyId: Number(c.id) },
  });
  await logAudit(client, ctx, { action: 'accept_assignment', resource: 'assets.assignments', recordId: custodyId, recordCode: null, metadata: {} });
  return { custodyId: Number(c.id), acceptedAt: c.accepted_at };
}

/** Return an asset from custody (employee exit, handback, store). */
export async function returnAsset(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (NOT_ASSIGNABLE.has(asset.status) && asset.status !== 'ASSIGNED' && asset.status !== 'IN_USE' && asset.status !== 'TRANSFERRED') {
    throw badRequest(`Asset status ${asset.status} cannot be returned`);
  }
  await client.query(
    `UPDATE asset_custody SET is_current = false, released_at = now()
     WHERE asset_id = $1 AND is_current = true`,
    [assetId]
  );
  const ins = await client.query(
    `INSERT INTO asset_custody
       (company_id, tenant_id, asset_id, custodian_user_id, custodian_employee_id, custodian_department_id,
        action, from_user_id, from_department_id, is_current, released_at, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'RETURN',$7,$8,false,now(),$9,$10) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, assetId,
      asset.custodian_user_id ?? null, asset.custodian_employee_id ?? null, asset.custodian_department_id ?? null,
      asset.custodian_user_id ?? null, asset.custodian_department_id ?? null,
      s(b.reason), ctx.userId ?? null,
    ]
  );
  const custodyId = Number(ins.rows[0].id);
  const returnToStore = b.returnToStore === true || b.returnToStore === 'true';
  const newStatus = returnToStore ? 'IN_STORE' : 'AVAILABLE';
  const condition = s(b.condition) ? String(b.condition).toUpperCase() : asset.condition;
  await client.query(
    `UPDATE asset_register
        SET custodian_user_id = NULL, custodian_employee_id = NULL, custodian_department_id = NULL,
            assigned_date = NULL, expected_return_date = NULL,
            custody_status = 'UNASSIGNED', status = $1, condition = $2, updated_by = $3
      WHERE id = $4`,
    [newStatus, condition, ctx.userId ?? null, assetId]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'RETURNED', title: 'Asset returned from custody',
    oldValue: asset.status, newValue: newStatus, reason: s(b.reason),
    metadata: { custodyId },
  });
  await logAudit(client, ctx, {
    action: 'return', resource: 'assets.assignments', recordId: custodyId,
    recordCode: asset.asset_no, newValues: { status: newStatus, custodyStatus: 'UNASSIGNED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.returned', entityType: 'assets.register', entityId: assetId,
    entityCode: asset.asset_no, payload: { custodyId, status: newStatus },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_storekeeper'], {
    type: 'ASSET_RETURNED', title: 'Asset returned', body: `${asset.asset_no} (${asset.name}) returned to store`,
    entityType: 'assets.register', entityId: assetId, severity: 'INFO',
  });
  return { custodyId, assetId, status: newStatus, custodyStatus: 'UNASSIGNED' };
}

/** Custody ledger (assignments history + current holders). */
export async function listCustody(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'c.tenant_id = $1 AND c.company_id = $2';
  if (q.assetId) { params.push(Number(q.assetId)); where += ` AND c.asset_id = $${params.length}`; }
  if (q.custodianUserId) { params.push(Number(q.custodianUserId)); where += ` AND c.custodian_user_id = $${params.length}`; }
  if (q.current === 'true' || q.current === true) where += ' AND c.is_current = true';
  if (q.current === 'false' || q.current === false) where += ' AND c.is_current = false';
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT c.*, a.asset_no, a.name AS asset_name,
            cu.first_name || ' ' || cu.last_name AS custodian_name,
            fu.first_name || ' ' || fu.last_name AS from_user_name,
            du.name AS department_name
     FROM asset_custody c
     JOIN asset_register a ON a.id = c.asset_id
     LEFT JOIN users cu ON cu.id = c.custodian_user_id
     LEFT JOIN users fu ON fu.id = c.from_user_id
     LEFT JOIN departments du ON du.id = c.custodian_department_id
     WHERE ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

// ============================================================
// Asset transfers (employee/department/branch/warehouse/location)
// ============================================================

const TRANSFER_EXCLUDED = new Set(['DISPOSED', 'RETIRED', 'ARCHIVED', 'MISSING', 'LOST', 'STOLEN', 'UNDER_MAINTENANCE', 'UNDER_INSPECTION']);
const DUAL_CONTROL_THRESHOLD = 100_000_000; // UGX: high-value transfers require dual control

export async function requestTransfer(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const transferType = s(b.transferType) ?? 'LOCATION';
  const allowedTypes = ['EMPLOYEE', 'DEPARTMENT', 'BRANCH', 'WAREHOUSE', 'LOCATION', 'PROJECT'];
  if (!allowedTypes.includes(transferType)) throw badRequest(`Invalid transfer type. Allowed: ${allowedTypes.join(', ')}`);
  const assetIds = Array.isArray(b.assetIds) ? b.assetIds.map(Number).filter((x) => Number.isFinite(x) && x > 0) : [];
  if (assetIds.length === 0) throw badRequest('At least one asset is required');
  if (assetIds.length > 100) throw badRequest('A transfer can contain at most 100 assets');
  if (assetIds.length !== new Set(assetIds).size) throw badRequest('Duplicate assets in transfer');

  let totalValue = 0;
  let highValue = false;
  const assets: Record<string, unknown>[] = [];
  for (const assetId of assetIds) {
    const asset = await loadAsset(client, ctx, assetId);
    if (TRANSFER_EXCLUDED.has(asset.status)) {
      throw badRequest(`Asset ${asset.asset_no} (${asset.status}) cannot be transferred`);
    }
    if (asset.custody_status === 'IN_TRANSIT') throw badRequest(`Asset ${asset.asset_no} is already in transit`);
    totalValue += num0(asset.current_book_value);
    if (asset.is_high_value === true) highValue = true;
    assets.push(asset);
  }

  const transferNo = await nextNo(client, ctx, 'TF');
  const requiresDualControl = highValue || totalValue >= DUAL_CONTROL_THRESHOLD;
  const ins = await client.query(
    `INSERT INTO asset_transfers
       (company_id, tenant_id, branch_id, transfer_no, transfer_type,
        from_location_id, to_location_id, from_department_id, to_department_id,
        from_branch_id, to_branch_id, from_user_id, to_user_id, reason,
        total_value, requires_dual_control, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'SUBMITTED',$17) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, n(b.branchId) ?? assets[0].branch_id ?? ctx.branchId ?? null,
      transferNo, transferType,
      assets[0].location_id ?? null, n(b.toLocationId),
      assets[0].department_id ?? null, n(b.toDepartmentId),
      assets[0].branch_id ?? null, n(b.toBranchId),
      assets[0].custodian_user_id ?? null, n(b.toUserId),
      s(b.reason), Number(totalValue.toFixed(2)), requiresDualControl, ctx.userId ?? null,
    ]
  );
  const transferId = Number(ins.rows[0].id);
  for (const asset of assets) {
    await client.query(
      `INSERT INTO asset_transfer_items (company_id, tenant_id, transfer_id, asset_id)
       VALUES ($1,$2,$3,$4)`,
      [ctx.companyId, ctx.tenantId, transferId, asset.id]
    );
    await client.query(
      `UPDATE asset_register SET status = 'TRANSFERRED', custody_status = 'IN_TRANSIT', updated_by = $2 WHERE id = $1`,
      [asset.id, ctx.userId ?? null]
    );
    await timeline(client, ctx, Number(asset.id), {
      eventType: 'TRANSFER_REQUESTED', title: 'Transfer requested',
      description: `Transfer ${transferNo} (${transferType}) requested`,
      oldValue: s(asset.status), newValue: 'TRANSFERRED',
      locationId: n(b.toLocationId), reason: s(b.reason),
      metadata: { transferId, transferNo },
    });
  }
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.transfers', recordId: transferId, recordCode: transferNo,
    newValues: { transferType, assetIds, totalValue, requiresDualControl },
  });
  await startWorkflow(client, ctx, {
    entityType: 'assets.transfers', entityId: transferId, entityCode: transferNo,
    amount: totalValue, companyId: ctx.companyId ?? null, branchId: n(b.branchId) ?? ctx.branchId ?? null,
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.transfer_requested', entityType: 'assets.transfers',
    entityId: transferId, entityCode: transferNo, payload: { assetIds, totalValue, requiresDualControl },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
    type: 'TRANSFER_REQUEST', title: 'Transfer requires approval',
    body: `Transfer ${transferNo} for ${assetIds.length} asset(s) (${totalValue.toLocaleString()} ${s(b.currency) ?? 'UGX'})`,
    entityType: 'assets.transfers', entityId: transferId, severity: requiresDualControl ? 'WARN' : 'INFO',
  });
  return { transferId, transferNo, assetCount: assetIds.length, totalValue, requiresDualControl, status: 'SUBMITTED' };
}

export async function getTransfer(client: pg.PoolClient, ctx: Ctx, transferId: number) {
  const res = await client.query(
    'SELECT * FROM asset_transfers WHERE id = $1 AND tenant_id = $2',
    [transferId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset transfer not found');
  const t = res.rows[0];
  const items = await client.query(
    `SELECT ti.*, a.asset_no, a.name AS asset_name, a.serial_no, a.location_id, a.custodian_user_id,
            q.code AS qr_code
     FROM asset_transfer_items ti
     JOIN asset_register a ON a.id = ti.asset_id
     LEFT JOIN qr_codes q ON q.id = a.qr_id
     WHERE ti.transfer_id = $1`,
    [transferId]
  );
  return { ...t, items: items.rows };
}

export async function listTransfers(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 't.tenant_id = $1 AND t.company_id = $2';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND t.status = $${params.length}`; }
  if (q.transferType) { params.push(String(q.transferType).toUpperCase()); where += ` AND t.transfer_type = $${params.length}`; }
  if (q.assetId) { params.push(Number(q.assetId)); where += ` AND EXISTS (SELECT 1 FROM asset_transfer_items ti WHERE ti.transfer_id = t.id AND ti.asset_id = $${params.length})`; }
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT t.*,
            (SELECT count(*) FROM asset_transfer_items ti WHERE ti.transfer_id = t.id)::int AS item_count,
            (SELECT count(*) FROM asset_transfer_items ti WHERE ti.transfer_id = t.id AND ti.verified_at IS NOT NULL)::int AS verified_count,
            al_from.name AS from_location_name, al_to.name AS to_location_name,
            u_from.first_name || ' ' || u_from.last_name AS from_user_name,
            u_to.first_name || ' ' || u_to.last_name AS to_user_name
     FROM asset_transfers t
     LEFT JOIN asset_locations al_from ON al_from.id = t.from_location_id
     LEFT JOIN asset_locations al_to ON al_to.id = t.to_location_id
     LEFT JOIN users u_from ON u_from.id = t.from_user_id
     LEFT JOIN users u_to ON u_to.id = t.to_user_id
     WHERE ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

/** Complete an approved transfer: handover + recipient confirmation + QR scan verification. */
export async function completeTransfer(client: pg.PoolClient, ctx: Ctx, transferId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [transferId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset transfer not found');
  const t = res.rows[0];
  if (t.status === 'COMPLETED') return { transferId, status: 'COMPLETED' };
  if (!['APPROVED', 'PENDING_HANDOVER'].includes(t.status)) {
    throw badRequest(`Transfer cannot be completed from status ${t.status}`);
  }
  const items = await client.query(
    `SELECT ti.*, a.asset_no, a.name AS asset_name, a.qr_id
     FROM asset_transfer_items ti
     JOIN asset_register a ON a.id = ti.asset_id
     WHERE ti.transfer_id = $1`,
    [transferId]
  );
  if (items.rows.length === 0) throw badRequest('Transfer has no items');

  const verified = new Set<number>();
  const verifiedIds = Array.isArray(b.verifiedAssetIds) ? b.verifiedAssetIds.map(Number).filter((x) => Number.isFinite(x) && x > 0) : [];
  const scanCodes = Array.isArray(b.scanCodes) ? b.scanCodes.map(String).filter(Boolean) : [];
  for (const id of verifiedIds) verified.add(id);
  if (scanCodes.length) {
    const qrRes = await client.query(
      `SELECT a.id FROM asset_register a JOIN qr_codes q ON q.id = a.qr_id
       WHERE q.code = ANY($1) AND a.tenant_id = $2`,
      [scanCodes, ctx.tenantId]
    );
    for (const row of qrRes.rows) verified.add(Number(row.id));
  }
  const unverified = items.rows.filter((it) => !verified.has(Number(it.asset_id)));
  if (unverified.length > 0) {
    throw badRequest(`Every transfer item must be QR-verified before completion. Unverified: ${unverified.map((it) => it.asset_no).join(', ')}`);
  }

  for (const it of items.rows) {
    const assetId = Number(it.asset_id);
    const asset = await loadAsset(client, ctx, assetId);
    await client.query(
      `UPDATE asset_transfer_items SET verified_at = now(), verified_by = $2 WHERE id = $1`,
      [it.id, ctx.userId ?? null]
    );
    await client.query(
      `UPDATE asset_custody SET is_current = false, released_at = now()
       WHERE asset_id = $1 AND is_current = true`,
      [assetId]
    );
    const toUser = n(t.to_user_id);
    const toLocation = n(t.to_location_id) ?? asset.location_id;
    const newStatus = toUser ? 'ASSIGNED' : 'IN_STORE';
    await client.query(
      `UPDATE asset_register
          SET custodian_user_id = $1, custodian_department_id = $2,
              location_id = $3, branch_id = COALESCE($4, branch_id),
              custody_status = 'ASSIGNED', status = $5, updated_by = $6
        WHERE id = $7`,
      [toUser, n(t.to_department_id), toLocation, n(t.to_branch_id), newStatus, ctx.userId ?? null, assetId]
    );
    const cins = await client.query(
      `INSERT INTO asset_custody
         (company_id, tenant_id, asset_id, custodian_user_id, custodian_department_id,
          action, from_user_id, from_department_id, assigned_date, is_current, accepted_at, accepted_by, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'TRANSFER',$6,$7,CURRENT_DATE,true,now(),$8,$9,$10) RETURNING id`,
      [
        ctx.companyId, ctx.tenantId, assetId, toUser, n(t.to_department_id),
        t.from_user_id ?? asset.custodian_user_id ?? null, n(t.from_department_id),
        ctx.userId ?? null, s(t.reason), ctx.userId ?? null,
      ]
    );
    await client.query(
      `INSERT INTO asset_scans
         (company_id, tenant_id, asset_id, scan_type, result, location_id, note, scanned_by, metadata)
       VALUES ($1,$2,$3,'TRANSFER','VERIFIED',$4,$5,$6,$7)`,
      [ctx.companyId, ctx.tenantId, assetId, toLocation, `Handover for transfer ${t.transfer_no}`, ctx.userId ?? null, JSON.stringify({ transferId })]
    );
    await timeline(client, ctx, assetId, {
      eventType: 'TRANSFER_COMPLETED', title: 'Transfer completed',
      description: `Handover completed for transfer ${t.transfer_no}`,
      oldValue: asset.status, newValue: newStatus,
      locationId: toLocation, reason: s(t.reason),
      metadata: { transferId: Number(t.id), custodyId: Number(cins.rows[0].id) },
    });
  }
  await client.query(
    `UPDATE asset_transfers
        SET status = 'COMPLETED', handover_at = now(), handover_by = $2,
            recipient_confirmed_at = now(), recipient_confirmed_by = $3, updated_by = $2
      WHERE id = $1`,
    [transferId, ctx.userId ?? null, n(b.recipientConfirmedBy) ?? ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'complete', resource: 'assets.transfers', recordId: transferId,
    recordCode: String(t.transfer_no), newValues: { status: 'COMPLETED', verifiedCount: items.rows.length },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.transfer_completed', entityType: 'assets.transfers',
    entityId: transferId, entityCode: String(t.transfer_no), payload: { assetIds: items.rows.map((it) => Number(it.asset_id)) },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_storekeeper', 'asset_manager'], {
    type: 'TRANSFER_COMPLETED', title: 'Transfer completed',
    body: `Transfer ${t.transfer_no} completed (${items.rows.length} asset(s))`,
    entityType: 'assets.transfers', entityId: transferId, severity: 'INFO',
  });
  return { transferId, status: 'COMPLETED', itemCount: items.rows.length };
}

// ============================================================
// Missing / lost / stolen asset workflow
// ============================================================

export async function reportMissing(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (['DISPOSED', 'RETIRED', 'ARCHIVED', 'LOST', 'STOLEN'].includes(asset.status)) {
    throw badRequest(`Asset status ${asset.status} cannot be reported missing`);
  }
  const locationId = n(b.locationId) ?? asset.location_id ?? asset.last_scan_location_id;
  await client.query(
    `UPDATE asset_register SET status = 'MISSING', last_scan_location_id = $1, updated_by = $2 WHERE id = $3`,
    [locationId, ctx.userId ?? null, assetId]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'MISSING_REPORTED', title: 'Asset reported missing',
    description: s(b.description) ?? 'Asset could not be located',
    oldValue: asset.status, newValue: 'MISSING',
    locationId, reason: s(b.reason),
    metadata: { lastScanAt: asset.last_scan_at, lastCustodianUserId: asset.custodian_user_id },
  });
  await logAudit(client, ctx, {
    action: 'report_missing', resource: 'assets', recordId: assetId, recordCode: asset.asset_no,
    newValues: { status: 'MISSING', description: s(b.description) },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.reported_missing', entityType: 'assets.register', entityId: assetId,
    entityCode: asset.asset_no, payload: { locationId, lastCustodianUserId: asset.custodian_user_id },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'security_administrator', 'asset_auditor'], {
    type: 'ASSET_MISSING', title: 'Asset reported missing',
    body: `${asset.asset_no} (${asset.name}) reported missing. Last custodian: ${asset.custodian_user_id ?? 'unknown'}`,
    entityType: 'assets.register', entityId: assetId, severity: 'ERROR', actionRequired: true,
  });
  return { assetId, status: 'MISSING' };
}

/** Escalate MISSING -> LOST / STOLEN. Authorized investigators only (checked in route). */
export async function escalateMissing(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (asset.status !== 'MISSING') throw badRequest('Only a missing asset can be escalated to lost/stolen');
  const toStatus = s(b.toStatus) ?? 'LOST';
  if (!['LOST', 'STOLEN'].includes(toStatus)) throw badRequest('Escalation target must be LOST or STOLEN');
  await client.query(
    `UPDATE asset_register SET status = $1, updated_by = $2 WHERE id = $3`,
    [toStatus, ctx.userId ?? null, assetId]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'MISSING_ESCALATED', title: `Asset declared ${toStatus}`,
    description: s(b.description) ?? 'Investigation concluded',
    oldValue: 'MISSING', newValue: toStatus, reason: s(b.reason),
    metadata: { investigationNote: s(b.investigationNote) },
  });
  await logAudit(client, ctx, {
    action: 'escalate_missing', resource: 'assets', recordId: assetId, recordCode: asset.asset_no,
    newValues: { status: toStatus, reason: s(b.reason) },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
    type: 'ASSET_LOST', title: `Asset ${toStatus}`,
    body: `${asset.asset_no} (${asset.name}) declared ${toStatus} after investigation`,
    entityType: 'assets.register', entityId: assetId, severity: 'ERROR', actionRequired: true,
  });
  return { assetId, status: toStatus };
}

/** Recover a missing/lost asset; restore custody and location. */
export async function recoverMissing(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (!['MISSING', 'LOST', 'STOLEN'].includes(asset.status)) {
    throw badRequest(`Asset status ${asset.status} is not missing`);
  }
  const custodianUserId = n(b.custodianUserId);
  const locationId = n(b.locationId) ?? asset.location_id ?? asset.last_scan_location_id;
  const newStatus = custodianUserId ? 'ASSIGNED' : 'AVAILABLE';
  await client.query(
    `UPDATE asset_custody SET is_current = false, released_at = now()
     WHERE asset_id = $1 AND is_current = true`,
    [assetId]
  );
  let custodyId: number | null = null;
  if (custodianUserId) {
    const ins = await client.query(
      `INSERT INTO asset_custody
         (company_id, tenant_id, asset_id, custodian_user_id, custodian_department_id, action,
          from_user_id, assigned_date, is_current, accepted_at, accepted_by, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'REASSIGN',$6,CURRENT_DATE,true,now(),$7,$8,$9) RETURNING id`,
      [ctx.companyId, ctx.tenantId, assetId, custodianUserId, n(b.custodianDepartmentId), asset.custodian_user_id ?? null, ctx.userId ?? null, s(b.reason), ctx.userId ?? null]
    );
    custodyId = Number(ins.rows[0].id);
  }
  await client.query(
    `UPDATE asset_register
        SET status = $1, custodian_user_id = $2, custodian_department_id = $3,
            location_id = $4, custody_status = $5, condition = COALESCE($6, condition), updated_by = $7
      WHERE id = $8`,
    [newStatus, custodianUserId, n(b.custodianDepartmentId), locationId, custodianUserId ? 'ASSIGNED' : 'UNASSIGNED', s(b.condition) ? String(b.condition).toUpperCase() : null, ctx.userId ?? null, assetId]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'RECOVERED', title: 'Asset recovered',
    description: s(b.description) ?? 'Asset located and recovered',
    oldValue: asset.status, newValue: newStatus, locationId, reason: s(b.reason),
    metadata: { custodyId },
  });
  await logAudit(client, ctx, {
    action: 'recover_missing', resource: 'assets', recordId: assetId, recordCode: asset.asset_no,
    newValues: { status: newStatus, custodianUserId, locationId },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
    type: 'ASSET_RECOVERED', title: 'Asset recovered',
    body: `${asset.asset_no} (${asset.name}) recovered`,
    entityType: 'assets.register', entityId: assetId, severity: 'SUCCESS',
  });
  return { assetId, status: newStatus, custodyId };
}
// ============================================================
// Lifecycle: maintenance work orders (PM/CM/emergency/
// inspection/calibration/service/repair) with inventory parts
// reservation + issue, finance posting and notifications.
// ============================================================
const MWO_ALLOWED_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'CALIBRATION', 'SERVICE', 'REPAIR'];
const MWO_ALLOWED_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export async function listMaintenanceWorkOrders(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['wo.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (clause: string, v: unknown) => { params.push(v); where.push(`${clause} $${params.length}`); };
  if (q.assetId) add('AND wo.asset_id =', Number(q.assetId));
  if (q.status) add('AND wo.status =', String(q.status));
  if (q.maintenanceType) add('AND wo.maintenance_type =', String(q.maintenanceType));
  if (q.priority) add('AND wo.priority =', String(q.priority));
  if (q.search) {
    params.push(`%${String(q.search)}%`);
    where.push(`AND (wo.wo_no ILIKE $${params.length} OR a.name ILIKE $${params.length} OR a.asset_no ILIKE $${params.length})`);
  }
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  params.push(limit, offset);
  const base = `FROM asset_maintenance_work_orders wo
     JOIN asset_register a ON a.id = wo.asset_id
     LEFT JOIN users t ON t.id = wo.technician_user_id
     LEFT JOIN suppliers s ON s.id = wo.supplier_id
     WHERE ${where.join(' ')}`;
  const rows = await client.query(
    `SELECT wo.*, a.name AS asset_name, a.asset_no, a.status AS asset_status,
            t.first_name || ' ' || t.last_name AS technician_name, s.name AS supplier_name
     ${base} ORDER BY wo.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(`SELECT count(*)::int AS total ${base}`, params.slice(0, params.length - 2));
  return { rows: rows.rows, total: cnt.rows[0].total, page: Number(q.page) || 1, pageSize: limit };
}
export async function getMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT wo.*, a.name AS asset_name, a.asset_no, a.status AS asset_status,
            a.location_id, al.name AS location_name,
            t.first_name || ' ' || t.last_name AS technician_name, s.name AS supplier_name
     FROM asset_maintenance_work_orders wo
     JOIN asset_register a ON a.id = wo.asset_id
     LEFT JOIN asset_locations al ON al.id = a.location_id
     LEFT JOIN users t ON t.id = wo.technician_user_id
     LEFT JOIN suppliers s ON s.id = wo.supplier_id
     WHERE wo.id = $1 AND wo.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const parts = await client.query(
    `SELECT p.*, pr.name AS product_name, pr.code AS product_code, pr.sku
     FROM asset_maintenance_parts p JOIN products pr ON pr.id = p.product_id
     WHERE p.work_order_id = $1 ORDER BY p.id`,
    [id]
  );
  return { ...res.rows[0], parts: parts.rows };
}
/** Reserve inventory for each part line of a work order. */
async function upsertWorkOrderParts(
  client: pg.PoolClient,
  ctx: Ctx,
  woId: number,
  assetId: number,
  partsInput: unknown
) {
  const parts = Array.isArray(partsInput) ? (partsInput as Record<string, unknown>[]) : [];
  const existing = await client.query('SELECT id, reservation_id FROM asset_maintenance_parts WHERE work_order_id = $1', [woId]);
  for (const row of existing.rows) {
    if (row.reservation_id) {
      try { await inv.release(client, Number(row.reservation_id)); } catch { /* already released */ }
    }
  }
  await client.query('DELETE FROM asset_maintenance_parts WHERE work_order_id = $1', [woId]);
  for (const p of parts) {
    const productId = n(p.productId);
    const qty = Number(p.qty ?? p.quantity ?? 0);
    const unitCost = Number(p.unitCost ?? 0);
    if (!productId || !(qty > 0)) throw badRequest('Each part requires a valid productId and a qty greater than zero');
    let reservationId: number | null = null;
    try {
      reservationId = await inv.reserve(client, ctx, {
        product: productId, qty, refType: 'asset_maintenance', refId: woId,
      });
    } catch (err) {
      throw badRequest(`Insufficient stock to reserve product ${productId}: ${(err as Error).message}`);
    }
    await client.query(
      `INSERT INTO asset_maintenance_parts
         (company_id, tenant_id, work_order_id, asset_id, product_id, reserved_qty, issued_qty, unit_cost, reservation_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
      [ctx.companyId, ctx.tenantId, woId, assetId, productId, qty, unitCost, reservationId]
    );
  }
}
export async function createMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const assetId = n(b.assetId);
  if (!assetId) throw badRequest('assetId is required');
  const asset = await loadAsset(client, ctx, assetId);
  const maintenanceType = s(b.maintenanceType) ?? 'CORRECTIVE';
  if (!MWO_ALLOWED_TYPES.includes(maintenanceType)) {
    throw badRequest(`Invalid maintenance type. Allowed: ${MWO_ALLOWED_TYPES.join(', ')}`);
  }
  const priority = s(b.priority) ?? 'MEDIUM';
  if (!MWO_ALLOWED_PRIORITIES.includes(priority)) {
    throw badRequest(`Invalid priority. Allowed: ${MWO_ALLOWED_PRIORITIES.join(', ')}`);
  }
  const woNo = await nextNo(client, ctx, 'WO');
  const ins = await client.query(
    `INSERT INTO asset_maintenance_work_orders
       (company_id, tenant_id, branch_id, asset_id, wo_no, maintenance_type, priority,
        technician_user_id, supplier_id, scheduled_date, cost, downtime_hours, description,
        next_maintenance_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, n(b.branchId) ?? asset.branch_id ?? ctx.branchId ?? null,
      assetId, woNo, maintenanceType, priority, n(b.technicianUserId), n(b.supplierId),
      s(b.scheduledDate), Number(b.cost ?? 0), Number(b.downtimeHours ?? 0), s(b.description),
      s(b.nextMaintenanceDate), ctx.userId ?? null,
    ]
  );
  const workOrderId = Number(ins.rows[0].id);
  await upsertWorkOrderParts(client, ctx, workOrderId, assetId, b.parts);
  await timeline(client, ctx, assetId, {
    eventType: 'MAINTENANCE_REQUESTED', title: 'Maintenance work order created',
    description: `Work order ${woNo} (${maintenanceType}) created`,
    oldValue: asset.status, newValue: asset.status,
    reason: s(b.description), metadata: { workOrderId, woNo, maintenanceType, priority },
  });
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.maintenance', recordId: workOrderId, recordCode: woNo,
    newValues: { assetId, maintenanceType, priority, cost: b.cost ?? 0 },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.maintenance_created', entityType: 'assets.maintenance',
    entityId: workOrderId, entityCode: woNo,
    payload: { assetId, maintenanceType, priority, status: 'DRAFT' },
  });
  return { workOrderId, woNo, status: 'DRAFT' };
}
export async function updateMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const wo = res.rows[0];
  if (!['DRAFT', 'SUBMITTED'].includes(wo.status)) {
    throw badRequest(`Work order can only be edited from DRAFT/SUBMITTED (current: ${wo.status})`);
  }
  const maintenanceType = s(b.maintenanceType) ?? wo.maintenance_type;
  if (!MWO_ALLOWED_TYPES.includes(maintenanceType)) {
    throw badRequest(`Invalid maintenance type. Allowed: ${MWO_ALLOWED_TYPES.join(', ')}`);
  }
  const priority = s(b.priority) ?? wo.priority;
  if (!MWO_ALLOWED_PRIORITIES.includes(priority)) {
    throw badRequest(`Invalid priority. Allowed: ${MWO_ALLOWED_PRIORITIES.join(', ')}`);
  }
  await client.query(
    `UPDATE asset_maintenance_work_orders
        SET maintenance_type = $1, priority = $2, technician_user_id = $3, supplier_id = $4,
            scheduled_date = $5, cost = $6, downtime_hours = $7, description = $8,
            next_maintenance_date = $9, updated_by = $10
      WHERE id = $11`,
    [
      maintenanceType, priority, n(b.technicianUserId) ?? wo.technician_user_id,
      n(b.supplierId) ?? wo.supplier_id, s(b.scheduledDate) ?? wo.scheduled_date,
      Number(b.cost ?? wo.cost), Number(b.downtimeHours ?? wo.downtime_hours),
      s(b.description) ?? wo.description, s(b.nextMaintenanceDate) ?? wo.next_maintenance_date,
      ctx.userId ?? null, workOrderId,
    ]
  );
  if (b.parts !== undefined) {
    await upsertWorkOrderParts(client, ctx, workOrderId, Number(wo.asset_id), b.parts);
  }
  await logAudit(client, ctx, {
    action: 'update', resource: 'assets.maintenance', recordId: workOrderId, recordCode: String(wo.wo_no),
    newValues: { maintenanceType, priority, cost: Number(b.cost ?? wo.cost) },
  });
  await timeline(client, ctx, Number(wo.asset_id), {
    eventType: 'MAINTENANCE_UPDATED', title: 'Maintenance work order updated',
    description: `Work order ${wo.wo_no} updated`,
    oldValue: wo.status, newValue: wo.status, metadata: { workOrderId },
  });
  return { workOrderId, status: wo.status };
}
export async function submitMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const res = await client.query(
    'SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const wo = res.rows[0];
  if (wo.status !== 'DRAFT') throw badRequest(`Only draft work orders can be submitted (current: ${wo.status})`);
  await client.query(
    `UPDATE asset_maintenance_work_orders SET status = 'SUBMITTED', updated_by = $2 WHERE id = $1`,
    [workOrderId, ctx.userId ?? null]
  );
  await startWorkflow(client, ctx, {
    entityType: 'assets.maintenance', entityId: workOrderId, entityCode: String(wo.wo_no),
    amount: num0(wo.cost), companyId: ctx.companyId ?? null, branchId: n(wo.branch_id) ?? ctx.branchId ?? null,
  });
  await logAudit(client, ctx, {
    action: 'submit', resource: 'assets.maintenance', recordId: workOrderId,
    recordCode: String(wo.wo_no), newValues: { status: 'SUBMITTED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.maintenance_submitted', entityType: 'assets.maintenance',
    entityId: workOrderId, entityCode: String(wo.wo_no), payload: { status: 'SUBMITTED' },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
    type: 'MAINTENANCE_REQUEST', title: 'Maintenance work order requires approval',
    body: `Work order ${wo.wo_no} for asset ${wo.asset_id} submitted for approval`,
    entityType: 'assets.maintenance', entityId: workOrderId, severity: 'INFO',
  });
  return { workOrderId, woNo: wo.wo_no, status: 'SUBMITTED' };
}
export async function completeMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const wo = res.rows[0];
  if (!['APPROVED', 'IN_PROGRESS'].includes(wo.status)) {
    throw badRequest(`Work order can only be completed from APPROVED/IN_PROGRESS (current: ${wo.status})`);
  }
  const asset = await loadAsset(client, ctx, Number(wo.asset_id));
  const parts = await client.query('SELECT * FROM asset_maintenance_parts WHERE work_order_id = $1', [workOrderId]);
  let partsCost = 0;
  for (const p of parts.rows) {
    const qty = num0(p.reserved_qty);
    partsCost += qty * num0(p.unit_cost);
    if (p.reservation_id) await inv.consume(client, Number(p.reservation_id));
    await client.query(
      `UPDATE asset_maintenance_parts SET issued_qty = $1, issued_at = now(), issued_by = $2 WHERE id = $3`,
      [qty, ctx.userId ?? null, p.id]
    );
  }
  const serviceCost = num0(wo.cost);
  const totalCost = Number((serviceCost + partsCost).toFixed(2));
  const completedDate = s(b.completedDate) ?? new Date().toISOString().slice(0, 10);
  let glJournalId: number | null = null;
  if (totalCost > 0) {
    const maintExpId = await finance.getAccountId(client, ctx, '6400');
    const lines: finance.JournalLine[] = [
      { account_id: maintExpId, debit: totalCost, description: `Maintenance ${wo.wo_no} - ${asset.asset_no}` },
    ];
    if (partsCost > 0) {
      const rawInvId = await finance.getAccountId(client, ctx, '1310');
      lines.push({ account_id: rawInvId, credit: partsCost, description: `Spare parts issued - ${wo.wo_no}` });
    }
    if (serviceCost > 0) {
      const apId = await finance.getAccountId(client, ctx, '2100');
      lines.push({ account_id: apId, credit: serviceCost, description: `Maintenance service - ${wo.wo_no}` });
    }
    glJournalId = await finance.postJournalLines(client, ctx, {
      entryDate: completedDate,
      journalType: 'ASSET_MAINTENANCE',
      description: `Maintenance ${wo.wo_no} - ${asset.asset_no}`,
      lines, refType: 'asset_maintenance', refId: workOrderId, refCode: String(wo.wo_no),
    });
  }
  const nextMaintenanceDate = s(b.nextMaintenanceDate) ?? wo.next_maintenance_date ?? null;
  const restoreStatus = asset.custody_status === 'ASSIGNED' ? 'ASSIGNED' : 'AVAILABLE';
  const newCondition = s(b.condition) ? String(b.condition).toUpperCase() : null;
  await client.query(
    `UPDATE asset_register
        SET status = $1, maintenance_status = $2, last_maintenance = $3, next_maintenance = $4,
            condition = COALESCE($5, condition), operational_state = $6, updated_by = $7
      WHERE id = $8`,
    [
      restoreStatus, nextMaintenanceDate ? 'NONE_DUE' : 'NONE', completedDate, nextMaintenanceDate,
      newCondition, newCondition ? 'OPERATIONAL' : asset.operational_state, ctx.userId ?? null, asset.id,
    ]
  );
  await client.query(
    `UPDATE asset_maintenance_work_orders
        SET status = 'COMPLETED', completed_date = $1, completed_by = $2, gl_journal_id = $3, updated_by = $4
      WHERE id = $5`,
    [completedDate, ctx.userId ?? null, glJournalId, ctx.userId ?? null, workOrderId]
  );
  await timeline(client, ctx, asset.id, {
    eventType: 'MAINTENANCE_COMPLETED', title: 'Maintenance completed',
    description: `Work order ${wo.wo_no} completed (${totalCost.toLocaleString()} ${asset.currency ?? 'UGX'})`,
    oldValue: wo.status, newValue: 'COMPLETED', locationId: asset.location_id,
    reason: s(b.completedNote) ?? s(wo.description),
    metadata: { workOrderId, woNo: wo.wo_no, totalCost, partsCost, serviceCost, glJournalId, nextMaintenanceDate },
  });
  await logAudit(client, ctx, {
    action: 'complete', resource: 'assets.maintenance', recordId: workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { status: 'COMPLETED', totalCost, partsCost, serviceCost, glJournalId, completedDate },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.maintenance_completed', entityType: 'assets.maintenance',
    entityId: workOrderId, entityCode: String(wo.wo_no),
    payload: { status: 'COMPLETED', assetId: asset.id, totalCost, glJournalId },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_custodian'], {
    type: 'MAINTENANCE_COMPLETED', title: 'Maintenance completed',
    body: `Work order ${wo.wo_no} completed for ${asset.asset_no} (${totalCost.toLocaleString()} ${asset.currency ?? 'UGX'})`,
    entityType: 'assets.maintenance', entityId: workOrderId, severity: 'SUCCESS',
  });
  return { workOrderId, woNo: wo.wo_no, status: 'COMPLETED', glJournalId, totalCost, partsCost, serviceCost };
}
export async function cancelMaintenanceWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Maintenance work order not found');
  const wo = res.rows[0];
  if (['COMPLETED', 'CANCELLED'].includes(wo.status)) {
    throw badRequest(`Work order is already ${wo.status}`);
  }
  const parts = await client.query('SELECT * FROM asset_maintenance_parts WHERE work_order_id = $1', [workOrderId]);
  for (const p of parts.rows) {
    if (p.reservation_id) {
      try { await inv.release(client, Number(p.reservation_id)); } catch { /* already released */ }
    }
  }
  await client.query(
    `UPDATE asset_maintenance_work_orders SET status = 'CANCELLED', updated_by = $2 WHERE id = $1`,
    [workOrderId, ctx.userId ?? null]
  );
  const asset = await loadAsset(client, ctx, Number(wo.asset_id));
  if (asset.status === 'UNDER_MAINTENANCE') {
    const restoreStatus = asset.custody_status === 'ASSIGNED' ? 'ASSIGNED' : 'AVAILABLE';
    await client.query(
      `UPDATE asset_register SET status = $1, maintenance_status = 'NONE', updated_by = $2 WHERE id = $3`,
      [restoreStatus, ctx.userId ?? null, asset.id]
    );
  }
  await timeline(client, ctx, Number(wo.asset_id), {
    eventType: 'MAINTENANCE_CANCELLED', title: 'Maintenance work order cancelled',
    description: `Work order ${wo.wo_no} cancelled`,
    oldValue: wo.status, newValue: 'CANCELLED', reason: s(b.reason),
    metadata: { workOrderId },
  });
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'assets.maintenance', recordId: workOrderId,
    recordCode: String(wo.wo_no), newValues: { status: 'CANCELLED' }, metadata: { reason: s(b.reason) },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.maintenance_cancelled', entityType: 'assets.maintenance',
    entityId: workOrderId, entityCode: String(wo.wo_no), payload: { status: 'CANCELLED' },
  });
  return { workOrderId, status: 'CANCELLED' };
}
// ============================================================
// Lifecycle: periodic asset audits (annual/quarterly/monthly/
// department/branch/spot/high-value) with mobile scan capture,
// exception management, dashboards and SoD on approval.
// ============================================================
const AUDIT_ALLOWED_TYPES = ['ANNUAL', 'QUARTERLY', 'MONTHLY', 'DEPARTMENT', 'BRANCH', 'SPOT', 'HIGH_VALUE'];
const AUDIT_ITEM_RESULTS = ['PENDING', 'VERIFIED', 'NOT_FOUND', 'WRONG_LOCATION', 'WRONG_CUSTODIAN', 'DAMAGED', 'TAG_MISSING', 'TAG_DAMAGED', 'UNEXPECTED'];
const AUDIT_EXCEPTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export async function listAudits(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId];
  let where = 'au.tenant_id = $1';
  const add = (clause: string, v: unknown) => { params.push(v); where += ` ${clause} $${params.length}`; };
  if (q.status) add('AND au.status =', String(q.status).toUpperCase());
  if (q.auditType) add('AND au.audit_type =', String(q.auditType).toUpperCase());
  if (q.branchId) add('AND au.branch_id =', Number(q.branchId));
  if (q.search) {
    params.push(`%${String(q.search)}%`);
    where += ` AND (au.audit_no ILIKE $${params.length} OR au.scope::text ILIKE $${params.length})`;
  }
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT au.*,
            (SELECT count(*) FROM asset_audit_items i WHERE i.audit_id = au.id)::int AS item_count,
            (SELECT count(*) FROM asset_audit_items i WHERE i.audit_id = au.id AND i.result = 'NOT_FOUND')::int AS not_found_count,
            (SELECT count(*) FROM asset_audit_exceptions e WHERE e.audit_id = au.id AND e.status = 'OPEN')::int AS open_exceptions,
            al.name AS location_name,
            u.first_name || ' ' || u.last_name AS created_by_name
     FROM asset_audits au
     LEFT JOIN asset_locations al ON al.id = au.location_id
     LEFT JOIN users u ON u.id = au.created_by
     WHERE ${where}
     ORDER BY au.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(`SELECT count(*)::int AS total FROM asset_audits au WHERE ${where}`, params.slice(0, params.length - 2));
  return { rows: rows.rows, total: cnt.rows[0].total, page: Number(q.page) || 1, pageSize: limit };
}
export async function getAudit(client: pg.PoolClient, ctx: Ctx, auditId: number) {
  const res = await client.query(
    `SELECT au.*, al.name AS location_name, u.first_name || ' ' || u.last_name AS created_by_name
     FROM asset_audits au
     LEFT JOIN asset_locations al ON al.id = au.location_id
     LEFT JOIN users u ON u.id = au.created_by
     WHERE au.id = $1 AND au.tenant_id = $2`,
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const items = await client.query(
    `SELECT i.*, a.asset_no, a.name AS asset_name, a.serial_no, a.status AS asset_status,
            a.condition AS asset_condition, al.name AS actual_location_name,
            ul.first_name || ' ' || ul.last_name AS scanned_by_name
     FROM asset_audit_items i
     JOIN asset_register a ON a.id = i.asset_id
     LEFT JOIN asset_locations al ON al.id = i.actual_location_id
     LEFT JOIN users ul ON ul.id = i.scanned_by
     WHERE i.audit_id = $1 ORDER BY i.id`,
    [auditId]
  );
  const exceptions = await client.query(
    `SELECT e.*, a.asset_no, a.name AS asset_name, u.first_name || ' ' || u.last_name AS resolved_by_name
     FROM asset_audit_exceptions e
     LEFT JOIN asset_register a ON a.id = e.asset_id
     LEFT JOIN users u ON u.id = e.resolved_by
     WHERE e.audit_id = $1 ORDER BY e.created_at DESC`,
    [auditId]
  );
  const summary = await client.query(
    `SELECT
       count(*) FILTER (WHERE result = 'PENDING')::int AS pending,
       count(*) FILTER (WHERE result = 'VERIFIED')::int AS verified,
       count(*) FILTER (WHERE result = 'NOT_FOUND')::int AS not_found,
       count(*) FILTER (WHERE result = 'WRONG_LOCATION')::int AS wrong_location,
       count(*) FILTER (WHERE result = 'WRONG_CUSTODIAN')::int AS wrong_custodian,
       count(*) FILTER (WHERE result = 'DAMAGED')::int AS damaged,
       count(*) FILTER (WHERE result IN ('TAG_MISSING','TAG_DAMAGED'))::int AS tag_issues,
       count(*) FILTER (WHERE result = 'UNEXPECTED')::int AS unexpected
     FROM asset_audit_items WHERE audit_id = $1`,
    [auditId]
  );
  return { ...res.rows[0], items: items.rows, exceptions: exceptions.rows, summary: summary.rows[0] };
}
export async function auditDashboard(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'au.tenant_id = $1 AND au.company_id = $2';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND au.status = $${params.length}`; }
  if (q.auditType) { params.push(String(q.auditType).toUpperCase()); where += ` AND au.audit_type = $${params.length}`; }
  const audits = await client.query(
    `SELECT
       count(*)::int AS total_audits,
       COALESCE(sum(au.expected_count), 0)::int AS total_expected,
       COALESCE(sum(au.verified_count), 0)::int AS total_verified,
       count(*) FILTER (WHERE au.status = 'PENDING_REVIEW')::int AS pending_review,
       count(*) FILTER (WHERE au.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE au.status = 'CLOSED')::int AS closed
     FROM asset_audits au WHERE ${where}`,
    params
  );
  const items = await client.query(
    `SELECT
       count(*) FILTER (WHERE i.result = 'NOT_FOUND')::int AS not_found,
       count(*) FILTER (WHERE i.result = 'WRONG_LOCATION')::int AS wrong_location,
       count(*) FILTER (WHERE i.result = 'WRONG_CUSTODIAN')::int AS wrong_custodian,
       count(*) FILTER (WHERE i.result = 'DAMAGED')::int AS damaged,
       count(*) FILTER (WHERE i.result IN ('TAG_MISSING','TAG_DAMAGED'))::int AS tag_missing,
       count(*) FILTER (WHERE i.result = 'UNEXPECTED')::int AS unexpected
     FROM asset_audit_items i
     JOIN asset_audits au ON au.id = i.audit_id
     WHERE ${where}`,
    params
  );
  return { ...audits.rows[0], ...items.rows[0] };
}
export async function createAudit(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const auditType = s(b.auditType) ?? 'ANNUAL';
  if (!AUDIT_ALLOWED_TYPES.includes(auditType)) {
    throw badRequest(`Invalid audit type. Allowed: ${AUDIT_ALLOWED_TYPES.join(', ')}`);
  }
  const auditNo = await nextNo(client, ctx, 'AU');
  const scope = {
    departmentId: n(b.departmentId),
    branchId: n(b.branchId),
    locationId: n(b.locationId),
    categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds.map(Number).filter((x) => Number.isFinite(x)) : [],
    highValueOnly: b.highValueOnly === true || b.highValueOnly === 'true',
    includeRetired: b.includeRetired === true || b.includeRetired === 'true',
  };
  const ins = await client.query(
    `INSERT INTO asset_audits
       (company_id, tenant_id, branch_id, audit_no, audit_type, scope, location_id, department_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, n(b.branchId) ?? ctx.branchId ?? null, auditNo, auditType,
      JSON.stringify(scope), n(b.locationId), n(b.departmentId), ctx.userId ?? null,
    ]
  );
  const auditId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.audits', recordId: auditId, recordCode: auditNo,
    newValues: { auditType, scope },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_created', entityType: 'assets.audits',
    entityId: auditId, entityCode: auditNo, payload: { auditType, status: 'DRAFT' },
  });
  return { auditId, auditNo, status: 'DRAFT', scope };
}
export async function updateAudit(client: pg.PoolClient, ctx: Ctx, auditId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (au.status !== 'DRAFT') throw badRequest(`Audit can only be edited from DRAFT (current: ${au.status})`);
  const auditType = s(b.auditType) ?? au.audit_type;
  if (!AUDIT_ALLOWED_TYPES.includes(auditType)) {
    throw badRequest(`Invalid audit type. Allowed: ${AUDIT_ALLOWED_TYPES.join(', ')}`);
  }
  const scope = {
    departmentId: n(b.departmentId) ?? n(au.scope?.departmentId) ?? null,
    branchId: n(b.branchId) ?? n(au.scope?.branchId) ?? null,
    locationId: n(b.locationId) ?? n(au.scope?.locationId) ?? null,
    categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds.map(Number).filter((x) => Number.isFinite(x)) : (au.scope?.categoryIds ?? []),
    highValueOnly: b.highValueOnly !== undefined ? b.highValueOnly === true || b.highValueOnly === 'true' : (au.scope?.highValueOnly ?? false),
    includeRetired: b.includeRetired !== undefined ? b.includeRetired === true || b.includeRetired === 'true' : (au.scope?.includeRetired ?? false),
  };
  await client.query(
    `UPDATE asset_audits SET audit_type = $1, scope = $2, location_id = $3, department_id = $4, updated_by = $5 WHERE id = $6`,
    [auditType, JSON.stringify(scope), n(b.locationId) ?? au.location_id, n(b.departmentId) ?? au.department_id, ctx.userId ?? null, auditId]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { auditType, scope },
  });
  return { auditId, auditNo: au.audit_no, status: 'DRAFT' };
}
/** Generate the audit item list from the scope and start the audit. */
export async function startAudit(client: pg.PoolClient, ctx: Ctx, auditId: number) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (!['DRAFT', 'SCHEDULED'].includes(au.status)) {
    throw badRequest(`Audit can only be started from DRAFT/SCHEDULED (current: ${au.status})`);
  }
  const scope = au.scope ?? {};
  const conds = ['a.tenant_id = $1', 'a.is_deleted = false'];
  const params: unknown[] = [ctx.tenantId];
  const addCond = (clause: string, v: unknown) => { params.push(v); conds.push(`${clause} $${params.length}`); };
  if (n(scope.locationId)) addCond('AND a.location_id =', n(scope.locationId));
  if (n(scope.departmentId)) addCond('AND a.department_id =', n(scope.departmentId));
  if (n(scope.branchId)) addCond('AND a.branch_id =', n(scope.branchId));
  if (Array.isArray(scope.categoryIds) && scope.categoryIds.length) {
    params.push(scope.categoryIds);
    conds.push(`AND a.category_id = ANY($${params.length})`);
  }
  if (scope.highValueOnly === true) conds.push('AND a.is_high_value = true');
  if (scope.includeRetired !== true) conds.push(`AND a.status NOT IN ('DISPOSED','RETIRED','ARCHIVED')`);
  const assets = await client.query(
    `SELECT id, location_id, custodian_user_id FROM asset_register a WHERE ${conds.join(' ')} ORDER BY a.id`,
    params
  );
  for (const asset of assets.rows) {
    await client.query(
      `INSERT INTO asset_audit_items
         (company_id, tenant_id, audit_id, asset_id, expected_location_id, expected_custodian_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (audit_id, asset_id) DO NOTHING`,
      [ctx.companyId, ctx.tenantId, auditId, asset.id, asset.location_id, asset.custodian_user_id]
    );
  }
  const countRes = await client.query('SELECT count(*)::int AS total FROM asset_audit_items WHERE audit_id = $1', [auditId]);
  await client.query(
    `UPDATE asset_audits SET status = 'IN_PROGRESS', expected_count = $1, started_at = now(), updated_by = $2 WHERE id = $3`,
    [countRes.rows[0].total, ctx.userId ?? null, auditId]
  );
  await logAudit(client, ctx, {
    action: 'start', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { status: 'IN_PROGRESS', expectedCount: countRes.rows[0].total },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_started', entityType: 'assets.audits',
    entityId: auditId, entityCode: String(au.audit_no),
    payload: { status: 'IN_PROGRESS', expectedCount: countRes.rows[0].total },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_auditor'], {
    type: 'AUDIT_STARTED', title: 'Asset audit started',
    body: `Audit ${au.audit_no} started with ${countRes.rows[0].total} expected asset(s)`,
    entityType: 'assets.audits', entityId: auditId, severity: 'INFO',
  });
  return { auditId, auditNo: au.audit_no, status: 'IN_PROGRESS', expectedCount: countRes.rows[0].total };
}
export async function submitAudit(client: pg.PoolClient, ctx: Ctx, auditId: number) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (au.status !== 'IN_PROGRESS') throw badRequest(`Audit can only be submitted from IN_PROGRESS (current: ${au.status})`);
  await client.query(
    `UPDATE asset_audits
        SET status = 'PENDING_REVIEW', verified_count =
            (SELECT count(*) FROM asset_audit_items WHERE audit_id = $1 AND result <> 'PENDING'),
            updated_by = $2
      WHERE id = $1`,
    [auditId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'submit', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { status: 'PENDING_REVIEW' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_submitted', entityType: 'assets.audits',
    entityId: auditId, entityCode: String(au.audit_no), payload: { status: 'PENDING_REVIEW' },
  });
  return { auditId, auditNo: au.audit_no, status: 'PENDING_REVIEW' };
}
export async function approveAudit(client: pg.PoolClient, ctx: Ctx, auditId: number) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (au.status !== 'PENDING_REVIEW') throw badRequest(`Audit can only be approved from PENDING_REVIEW (current: ${au.status})`);
  if (au.created_by === ctx.userId) {
    throw badRequest('Segregation of duties: the audit creator cannot approve their own audit');
  }
  await client.query(
    `UPDATE asset_audits SET status = 'APPROVED', updated_by = $2 WHERE id = $1`,
    [auditId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'approve', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { status: 'APPROVED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_approved', entityType: 'assets.audits',
    entityId: auditId, entityCode: String(au.audit_no), payload: { status: 'APPROVED' },
  });
  return { auditId, auditNo: au.audit_no, status: 'APPROVED' };
}
export async function closeAudit(client: pg.PoolClient, ctx: Ctx, auditId: number) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (au.status !== 'APPROVED') throw badRequest(`Audit can only be closed from APPROVED (current: ${au.status})`);
  await client.query(
    `UPDATE asset_audits
        SET status = 'CLOSED', completed_at = now(),
            verified_count = (SELECT count(*) FROM asset_audit_items WHERE audit_id = $1 AND result <> 'PENDING'),
            updated_by = $2
      WHERE id = $1`,
    [auditId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'close', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { status: 'CLOSED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_closed', entityType: 'assets.audits',
    entityId: auditId, entityCode: String(au.audit_no), payload: { status: 'CLOSED' },
  });
  return { auditId, auditNo: au.audit_no, status: 'CLOSED' };
}
export async function cancelAudit(client: pg.PoolClient, ctx: Ctx, auditId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset audit not found');
  const au = res.rows[0];
  if (!['DRAFT', 'SCHEDULED', 'IN_PROGRESS'].includes(au.status)) {
    throw badRequest(`Audit cannot be cancelled from ${au.status}`);
  }
  await client.query(
    `UPDATE asset_audits SET status = 'CANCELLED', updated_by = $2 WHERE id = $1`,
    [auditId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    newValues: { status: 'CANCELLED' }, metadata: { reason: s(b.reason) },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_cancelled', entityType: 'assets.audits',
    entityId: auditId, entityCode: String(au.audit_no), payload: { status: 'CANCELLED' },
  });
  return { auditId, auditNo: au.audit_no, status: 'CANCELLED' };
}
/** Record a mobile scan result against an audit item. Unexpected assets are
 *  captured as new UNEXPECTED items so nothing physical escapes the audit. */
export async function auditScan(client: pg.PoolClient, ctx: Ctx, auditId: number, b: Record<string, unknown>) {
  const auditRes = await client.query(
    'SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [auditId, ctx.tenantId]
  );
  if (auditRes.rows.length === 0) throw notFound('Asset audit not found');
  const au = auditRes.rows[0];
  if (au.status !== 'IN_PROGRESS') throw badRequest(`Assets can only be scanned on an IN_PROGRESS audit (current: ${au.status})`);
  let assetId = n(b.assetId);
  if (!assetId) {
    const code = s(b.code);
    if (!code) throw badRequest('Provide either assetId or a QR code');
    const qr = await findQrByCode(client, ctx, code);
    if (!qr) throw notFound('QR code not found');
    const bound = await client.query('SELECT id FROM asset_register WHERE qr_id = $1 AND tenant_id = $2', [qr.id, ctx.tenantId]);
    if (bound.rows.length === 0) throw badRequest('QR code is not bound to an asset');
    assetId = Number(bound.rows[0].id);
  }
  const asset = await loadAsset(client, ctx, assetId);
  const itemRes = await client.query(
    'SELECT * FROM asset_audit_items WHERE audit_id = $1 AND asset_id = $2 FOR UPDATE',
    [auditId, assetId]
  );
  let itemId: number;
  let expectedLocationId: number | null = null;
  let expectedCustodianUserId: number | null = null;
  if (itemRes.rows.length === 0) {
    const ins = await client.query(
      `INSERT INTO asset_audit_items
         (company_id, tenant_id, audit_id, asset_id, expected_location_id, expected_custodian_user_id, result)
       VALUES ($1,$2,$3,$4,$5,$6,'UNEXPECTED') RETURNING id`,
      [ctx.companyId, ctx.tenantId, auditId, assetId, asset.location_id, asset.custodian_user_id]
    );
    itemId = Number(ins.rows[0].id);
    expectedLocationId = asset.location_id;
    expectedCustodianUserId = asset.custodian_user_id;
  } else {
    const item = itemRes.rows[0];
    itemId = Number(item.id);
    expectedLocationId = item.expected_location_id;
    expectedCustodianUserId = item.expected_custodian_user_id;
  }
  const requestedResult = s(b.result) ? String(b.result).toUpperCase() : null;
  if (requestedResult && !AUDIT_ITEM_RESULTS.includes(requestedResult)) {
    throw badRequest(`Invalid audit result. Allowed: ${AUDIT_ITEM_RESULTS.join(', ')}`);
  }
  const actualLocationId = n(b.locationId) ?? asset.location_id;
  let result = requestedResult ?? 'VERIFIED';
  if (!requestedResult) {
    if (expectedLocationId && actualLocationId !== expectedLocationId) result = 'WRONG_LOCATION';
    else if (expectedCustodianUserId && n(b.custodianUserId) && n(b.custodianUserId) !== expectedCustodianUserId) result = 'WRONG_CUSTODIAN';
  }
  await client.query(
    `UPDATE asset_audit_items
        SET result = $1, actual_location_id = $2, note = $3, scanned_at = now(), scanned_by = $4
      WHERE id = $5`,
    [result, actualLocationId, s(b.note), ctx.userId ?? null, itemId]
  );
  await client.query(
    `UPDATE asset_audits
        SET verified_count = (SELECT count(*) FROM asset_audit_items WHERE audit_id = $1 AND result <> 'PENDING')
      WHERE id = $1`,
    [auditId]
  );
  await client.query(
    `UPDATE asset_register SET last_scan_at = now(), last_scan_location_id = $1, last_scan_user_id = $2 WHERE id = $3`,
    [actualLocationId, ctx.userId ?? null, asset.id]
  );
  if (result === 'VERIFIED') {
    await client.query(`UPDATE asset_register SET last_verified_at = now(), last_verified_by = $1 WHERE id = $2`, [ctx.userId ?? null, asset.id]);
  }
  const scanRes = await client.query(
    `INSERT INTO asset_scans
       (company_id, tenant_id, asset_id, scan_type, result, location_id, expected_values, actual_values, note, scanned_by, metadata)
     VALUES ($1,$2,$3,'AUDIT',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, asset.id, result, actualLocationId,
      JSON.stringify({ expectedLocationId, expectedCustodianUserId }),
      JSON.stringify({ locationId: actualLocationId, custodianUserId: asset.custodian_user_id }),
      s(b.note), ctx.userId ?? null, JSON.stringify({ auditId, auditNo: au.audit_no, auditItemId: itemId }),
    ]
  );
  const scanId = Number(scanRes.rows[0].id);
  await client.query('SELECT detect_asset_scan_anomalies($1,$2,$3)', [asset.id, scanId, actualLocationId]);
  let exceptionId: number | null = null;
  if (result !== 'VERIFIED' && result !== 'PENDING') {
    const severity = result === 'DAMAGED' || result === 'NOT_FOUND' ? 'HIGH' : 'MEDIUM';
    const exc = await client.query(
      `INSERT INTO asset_audit_exceptions
         (company_id, tenant_id, audit_id, audit_item_id, asset_id, exception_type, severity, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN') RETURNING id`,
      [
        ctx.companyId, ctx.tenantId, auditId, itemId, asset.id,
        result === 'UNEXPECTED' ? 'UNEXPECTED_ASSET' : `${result}`,
        severity, s(b.note) ?? `Asset ${asset.asset_no} recorded as ${result} during audit ${au.audit_no}`,
      ]
    );
    exceptionId = Number(exc.rows[0].id);
  }
  await timeline(client, ctx, asset.id, {
    eventType: result === 'VERIFIED' ? 'AUDIT_VERIFIED' : 'AUDIT_EXCEPTION',
    title: result === 'VERIFIED' ? 'Asset verified in audit' : `Audit exception: ${result}`,
    description: `Audit ${au.audit_no} scan result ${result}`,
    oldValue: null, newValue: result, locationId: actualLocationId,
    reason: s(b.note), metadata: { auditId, auditNo: au.audit_no, auditItemId: itemId, exceptionId },
  });
  await logAudit(client, ctx, {
    action: 'audit_scan', resource: 'assets.audits', recordId: auditId, recordCode: String(au.audit_no),
    metadata: { assetId: asset.id, itemId, result, scanId },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.audit_scan', entityType: 'assets.audits', entityId: auditId,
    entityCode: String(au.audit_no), payload: { assetId: asset.id, result, scanId, exceptionId },
  });
  return { auditId, auditItemId: itemId, assetId: asset.id, assetNo: asset.asset_no, result, scanId, exceptionId };
}
export async function updateAuditItem(client: pg.PoolClient, ctx: Ctx, auditId: number, itemId: number, b: Record<string, unknown>) {
  const res = await client.query(
    `SELECT i.*, au.status FROM asset_audit_items i
     JOIN asset_audits au ON au.id = i.audit_id
     WHERE i.id = $1 AND i.audit_id = $2 AND au.tenant_id = $3 FOR UPDATE`,
    [itemId, auditId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Audit item not found');
  const item = res.rows[0];
  if (!['IN_PROGRESS', 'PENDING_REVIEW'].includes(item.status)) {
    throw badRequest(`Audit item can only be corrected while the audit is IN_PROGRESS/PENDING_REVIEW`);
  }
  const result = s(b.result) ? String(b.result).toUpperCase() : item.result;
  if (!AUDIT_ITEM_RESULTS.includes(result)) throw badRequest(`Invalid audit result`);
  await client.query(
    `UPDATE asset_audit_items SET result = $1, note = $2, scanned_by = COALESCE($3, scanned_by) WHERE id = $4`,
    [result, s(b.note) ?? item.note, n(b.scannedBy) ?? null, itemId]
  );
  await logAudit(client, ctx, {
    action: 'update_item', resource: 'assets.audits', recordId: auditId,
    metadata: { assetId: Number(item.asset_id), itemId, result, note: s(b.note) }, newValues: { itemId, result },
  });
  return { auditId, auditItemId: itemId, result };
}
export async function addAuditException(client: pg.PoolClient, ctx: Ctx, auditId: number, b: Record<string, unknown>) {
  const au = await client.query('SELECT * FROM asset_audits WHERE id = $1 AND tenant_id = $2', [auditId, ctx.tenantId]);
  if (au.rows.length === 0) throw notFound('Asset audit not found');
  const exceptionType = s(b.exceptionType);
  if (!exceptionType) throw badRequest('exceptionType is required');
  const severity = s(b.severity) ?? 'MEDIUM';
  if (!AUDIT_EXCEPTION_SEVERITIES.includes(severity)) throw badRequest('Invalid severity');
  const assetId = n(b.assetId) ?? null;
  const ins = await client.query(
    `INSERT INTO asset_audit_exceptions
       (company_id, tenant_id, audit_id, audit_item_id, asset_id, exception_type, severity, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.companyId, ctx.tenantId, auditId, n(b.auditItemId), assetId, exceptionType, severity, s(b.description)]
  );
  const exceptionId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'add_exception', resource: 'assets.audits', recordId: auditId,
    recordCode: String(au.rows[0].audit_no), newValues: { exceptionId, exceptionType, severity, assetId },
  });
  if (assetId) {
    await timeline(client, ctx, assetId, {
      eventType: 'AUDIT_EXCEPTION', title: `Audit exception: ${exceptionType}`,
      description: s(b.description) ?? exceptionType,
      oldValue: null, newValue: exceptionType, reason: s(b.description),
      metadata: { auditId, auditNo: au.rows[0].audit_no, exceptionId },
    });
  }
  return { auditId, exceptionId, exceptionType, severity, status: 'OPEN' };
}
export async function resolveAuditException(client: pg.PoolClient, ctx: Ctx, exceptionId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_audit_exceptions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [exceptionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Audit exception not found');
  const exc = res.rows[0];
  const status = s(b.status) ? String(b.status).toUpperCase() : 'RESOLVED';
  if (!['RESOLVED', 'DISMISSED'].includes(status)) throw badRequest('Status must be RESOLVED or DISMISSED');
  if (!s(b.resolution) && status === 'RESOLVED') throw badRequest('A resolution note is required when resolving an exception');
  await client.query(
    `UPDATE asset_audit_exceptions
        SET status = $1, resolution = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $4`,
    [status, s(b.resolution), ctx.userId ?? null, exceptionId]
  );
  await logAudit(client, ctx, {
    action: 'resolve_exception', resource: 'assets.audits', recordId: Number(exc.audit_id),
    newValues: { exceptionId, status, resolution: s(b.resolution) },
  });
  return { exceptionId, status };
}
// ============================================================
// Standalone asset verification (mobile "Verify" mode): scan,
// compare expected info, confirm condition/custodian/location.
// ============================================================
export async function verificationList(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'a.tenant_id = $1 AND a.company_id = $2 AND a.is_deleted = false';
  if (q.status) { params.push(String(q.status).toUpperCase()); where += ` AND a.status = $${params.length}`; }
  if (q.locationId) { params.push(Number(q.locationId)); where += ` AND a.location_id = $${params.length}`; }
  if (q.departmentId) { params.push(Number(q.departmentId)); where += ` AND a.department_id = $${params.length}`; }
  if (q.dueOnly === true || q.dueOnly === 'true') {
    where += ` AND (a.last_verified_at IS NULL OR a.last_verified_at < now() - interval '90 days')`;
  }
  if (q.search) {
    params.push(`%${String(q.search)}%`);
    where += ` AND (a.asset_no ILIKE $${params.length} OR a.name ILIKE $${params.length} OR a.serial_no ILIKE $${params.length})`;
  }
  const limit = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = Math.max(0, (Number(q.page) || 1) - 1) * limit;
  params.push(limit, offset);
  const rows = await client.query(
    `SELECT a.id, a.asset_no, a.name, a.serial_no, a.status, a.condition, a.location_id,
            a.custodian_user_id, a.custody_status, a.last_verified_at, a.last_scan_at,
            al.name AS location_name,
            u.first_name || ' ' || u.last_name AS custodian_name,
            ac.name AS category_name,
            q.code AS qr_code
     FROM asset_register a
     LEFT JOIN asset_locations al ON al.id = a.location_id
     LEFT JOIN users u ON u.id = a.custodian_user_id
     LEFT JOIN asset_categories ac ON ac.id = a.category_id
     LEFT JOIN qr_codes q ON q.id = a.qr_id
     WHERE ${where}
     ORDER BY a.last_verified_at ASC NULLS FIRST, a.asset_no
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(`SELECT count(*)::int AS total FROM asset_register a WHERE ${where}`, params.slice(0, params.length - 2));
  return { rows: rows.rows, total: cnt.rows[0].total, page: Number(q.page) || 1, pageSize: limit };
}
/** Verify an asset in the field: compare expected vs actual and record the
 *  result, updating condition and last-verified metadata. */
export async function verifyAsset(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  let assetId = n(b.assetId);
  if (!assetId) {
    const code = s(b.code);
    if (!code) throw badRequest('Provide either assetId or a QR code');
    const qr = await findQrByCode(client, ctx, code);
    if (!qr) throw notFound('QR code not found');
    const bound = await client.query('SELECT id FROM asset_register WHERE qr_id = $1 AND tenant_id = $2', [qr.id, ctx.tenantId]);
    if (bound.rows.length === 0) throw badRequest('QR code is not bound to an asset');
    assetId = Number(bound.rows[0].id);
  }
  const asset = await loadAsset(client, ctx, assetId);
  const expected = {
    locationId: asset.location_id,
    custodianUserId: asset.custodian_user_id,
    status: asset.status,
    condition: asset.condition,
  };
  const actualLocationId = n(b.locationId) ?? asset.location_id;
  const actualCustodianUserId = n(b.custodianUserId) ?? asset.custodian_user_id;
  const newCondition = s(b.condition) ? String(b.condition).toUpperCase() : null;
  if (newCondition && !['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR', 'DISPOSED'].includes(newCondition)) {
    throw badRequest(`Invalid condition value: ${newCondition}`);
  }
  let result = s(b.result) ? String(b.result).toUpperCase() : 'VERIFIED';
  if (!['VERIFIED', 'WRONG_LOCATION', 'WRONG_CUSTODIAN', 'DAMAGED', 'TAG_MISSING', 'TAG_DAMAGED'].includes(result)) {
    throw badRequest(`Invalid verification result: ${result}`);
  }
  if (!s(b.result)) {
    if (actualLocationId !== asset.location_id) result = 'WRONG_LOCATION';
    else if (actualCustodianUserId !== asset.custodian_user_id) result = 'WRONG_CUSTODIAN';
    else if (newCondition === 'DAMAGED' || newCondition === 'CRITICAL') result = 'DAMAGED';
  }
  const actual = { locationId: actualLocationId, custodianUserId: actualCustodianUserId, condition: newCondition ?? asset.condition };
  await client.query(
    `UPDATE asset_register
        SET last_verified_at = now(), last_verified_by = $1, last_scan_at = now(),
            last_scan_location_id = $2, last_scan_user_id = $1,
            condition = COALESCE($3, condition), updated_by = $1
      WHERE id = $4`,
    [ctx.userId ?? null, actualLocationId, newCondition, asset.id]
  );
  const scanRes = await client.query(
    `INSERT INTO asset_scans
       (company_id, tenant_id, asset_id, qr_id, scan_type, result, location_id, expected_values, actual_values, note, device, scanned_by)
     VALUES ($1,$2,$3,$4,'VERIFY',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, asset.id, n(asset.qr_id), result, actualLocationId,
      JSON.stringify(expected), JSON.stringify(actual), s(b.note), s(b.device), ctx.userId ?? null,
    ]
  );
  const scanId = Number(scanRes.rows[0].id);
  await client.query('SELECT detect_asset_scan_anomalies($1,$2,$3)', [asset.id, scanId, actualLocationId]);
  await timeline(client, ctx, asset.id, {
    eventType: result === 'VERIFIED' ? 'ASSET_VERIFIED' : 'VERIFICATION_EXCEPTION',
    title: result === 'VERIFIED' ? 'Asset verified' : `Verification exception: ${result}`,
    description: `Field verification recorded as ${result}`,
    oldValue: asset.condition, newValue: newCondition ?? asset.condition,
    locationId: actualLocationId, reason: s(b.note),
    metadata: { scanId, expected, actual, result },
  });
  await logAudit(client, ctx, {
    action: 'verify', resource: 'assets.register', recordId: asset.id, recordCode: asset.asset_no,
    oldValues: expected, newValues: actual,
    metadata: { scanId, result, note: s(b.note) },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.verified', entityType: 'assets.register',
    entityId: asset.id, entityCode: asset.asset_no,
    payload: { result, scanId, locationId: actualLocationId },
  });
  return { assetId: asset.id, assetNo: asset.asset_no, result, scanId, expected, actual };
}
// ------------------------------------------------------------
// Disposal & retirement lifecycle (DRAFT -> SUBMITTED -> VALUATION
// -> INSPECTION -> APPROVED -> FINANCE_REVIEW -> COMPLETED).
// Completion posts the GL, voids tags and retires the asset.
// ------------------------------------------------------------
const DISPOSAL_REASONS = ['OBSOLETE', 'DAMAGED', 'BEYOND_REPAIR', 'SOLD', 'LOST', 'STOLEN', 'REPLACEMENT', 'END_OF_USEFUL_LIFE', 'OTHER'];
const DISPOSAL_METHODS = ['SALE', 'SCRAP', 'DONATION', 'RETURN_TO_SUPPLIER', 'WRITE_OFF', 'TRADE_IN'];
const DISPOSAL_STAGES = ['VALUATION', 'INSPECTION', 'APPROVED', 'FINANCE_REVIEW'];

export async function listDisposals(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where: string[] = ['d.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`d.company_id = $${params.length}`); }
  if (s(q.status)) { params.push(String(q.status).toUpperCase()); where.push(`d.status = $${params.length}`); }
  if (n(q.assetId)) { params.push(n(q.assetId)); where.push(`d.asset_id = $${params.length}`); }
  if (s(q.reason)) { params.push(String(q.reason).toUpperCase()); where.push(`d.reason = $${params.length}`); }
  if (s(q.search)) {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where.push(`(lower(d.disposal_no) LIKE $${params.length} OR lower(a.asset_no) LIKE $${params.length} OR lower(a.name) LIKE $${params.length})`);
  }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 200);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT d.*, a.asset_no, a.name AS asset_name, a.current_book_value AS book_value,
            COALESCE(u.first_name || ' ' || u.last_name, '') AS approved_by_name
     FROM asset_disposals d
     JOIN asset_register a ON a.id = d.asset_id
     LEFT JOIN users u ON u.id = d.approved_by
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM asset_disposals d JOIN asset_register a ON a.id = d.asset_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}

export async function getDisposal(client: pg.PoolClient, ctx: Ctx, disposalId: number) {
  const res = await client.query(
    `SELECT d.*, a.asset_no, a.name AS asset_name, a.category_id, a.status AS asset_status
     FROM asset_disposals d JOIN asset_register a ON a.id = d.asset_id
     WHERE d.id = $1 AND d.tenant_id = $2`,
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const approvals = await client.query(
    `SELECT approval_level, decision, approved_by, approved_at, comment,
            COALESCE(u.first_name || ' ' || u.last_name, '') AS approver_name
     FROM asset_disposal_approvals da LEFT JOIN users u ON u.id = da.approved_by
     WHERE da.disposal_id = $1 ORDER BY approval_level`,
    [disposalId]
  );
  return { ...res.rows[0], approvals: approvals.rows };
}

export async function createDisposal(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, Number(b.assetId));
  if (!asset) throw badRequest('assetId is required');
  if (['DISPOSED', 'RETIRED', 'ARCHIVED'].includes(asset.status)) {
    throw badRequest(`Asset ${asset.asset_no} is already ${asset.status.toLowerCase()}`);
  }
  const reason = s(b.reason) ?? 'END_OF_USEFUL_LIFE';
  const method = s(b.method) ?? 'SCRAP';
  if (!DISPOSAL_REASONS.includes(reason)) throw badRequest(`Invalid disposal reason: ${reason}`);
  if (!DISPOSAL_METHODS.includes(method)) throw badRequest(`Invalid disposal method: ${method}`);
  const disposalNo = await nextNo(client, ctx, 'DP');
  const valuation = n(b.valuation) ?? n(b.salePrice) ?? null;
  const bookValue = num0(asset.current_book_value);
  const requiresDualControl = Boolean(asset.is_high_value) || bookValue >= DUAL_CONTROL_THRESHOLD;
  const res = await client.query(
    `INSERT INTO asset_disposals
       (company_id, tenant_id, branch_id, asset_id, disposal_no, reason, method,
        valuation, sale_price, disposal_date, requires_dual_control, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, n(b.branchId) ?? ctx.branchId ?? null, asset.id, disposalNo,
      reason, method, valuation, n(b.salePrice) ?? null,
      s(b.disposalDate) ?? null, requiresDualControl, s(b.notes) ?? null, ctx.userId ?? null,
    ]
  );
  const disposalId = Number(res.rows[0].id);
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'DISPOSAL_REQUESTED', title: 'Disposal requested',
    description: `Disposal ${disposalNo} (${reason}) requested for ${asset.asset_no}`,
    oldValue: asset.status, newValue: 'DISPOSED',
    reason: s(b.notes), metadata: { disposalId, requiresDualControl, valuation, bookValue },
  });
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.disposals', recordId: disposalId, recordCode: disposalNo,
    newValues: { reason, method, valuation, requiresDualControl },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.disposal_created', entityType: 'assets.disposals',
    entityId: disposalId, entityCode: disposalNo,
    payload: { assetId: Number(asset.id), reason, method, requiresDualControl },
  });
  return { disposalId, disposalNo, reason, method, requiresDualControl, status: 'DRAFT' };
}

export async function updateDisposal(client: pg.PoolClient, ctx: Ctx, disposalId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_disposals WHERE id = $1 AND tenant_id = $2',
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const d = res.rows[0];
  if (!['DRAFT', 'SUBMITTED'].includes(d.status)) throw badRequest(`Disposal cannot be edited from status ${d.status}`);
  const reason = s(b.reason) ? String(b.reason).toUpperCase() : d.reason;
  const method = s(b.method) ? String(b.method).toUpperCase() : d.method;
  if (s(b.reason) && !DISPOSAL_REASONS.includes(reason)) throw badRequest(`Invalid disposal reason: ${reason}`);
  if (s(b.method) && !DISPOSAL_METHODS.includes(method)) throw badRequest(`Invalid disposal method: ${method}`);
  const valuation = n(b.valuation) ?? d.valuation;
  const salePrice = n(b.salePrice) ?? d.sale_price;
  await client.query(
    `UPDATE asset_disposals
        SET reason = $2, method = $3, valuation = $4, sale_price = $5,
            disposal_date = COALESCE($6, disposal_date), notes = COALESCE($7, notes), updated_by = $8
      WHERE id = $1`,
    [disposalId, reason, method, valuation, salePrice, s(b.disposalDate) ?? null, s(b.notes) ?? null, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'assets.disposals', recordId: disposalId, recordCode: String(d.disposal_no),
    oldValues: { reason: d.reason, method: d.method, valuation: d.valuation, sale_price: d.sale_price },
    newValues: { reason, method, valuation, salePrice },
  });
  return { disposalId, status: d.status };
}

export async function submitDisposal(client: pg.PoolClient, ctx: Ctx, disposalId: number) {
  const res = await client.query(
    'SELECT * FROM asset_disposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const d = res.rows[0];
  if (d.status !== 'DRAFT') throw badRequest(`Disposal can only be submitted from DRAFT (current: ${d.status})`);
  const asset = await loadAsset(client, ctx, Number(d.asset_id));
  const amount = n(d.valuation) ?? num0(asset.current_book_value);
  await client.query('UPDATE asset_disposals SET status = $2, updated_by = $3 WHERE id = $1', [disposalId, 'SUBMITTED', ctx.userId ?? null]);
  await startWorkflow(client, ctx, {
    entityType: 'assets.disposals', entityId: disposalId, entityCode: String(d.disposal_no),
    amount, companyId: ctx.companyId ?? null, branchId: n(d.branch_id) ?? ctx.branchId ?? null,
  });
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'DISPOSAL_SUBMITTED', title: 'Disposal submitted for approval',
    description: `Disposal ${d.disposal_no} submitted (${d.method})`,
    oldValue: 'DRAFT', newValue: 'SUBMITTED',
    metadata: { disposalId, amount, requiresDualControl: d.requires_dual_control },
  });
  await logAudit(client, ctx, {
    action: 'submit', resource: 'assets.disposals', recordId: disposalId, recordCode: String(d.disposal_no),
    newValues: { status: 'SUBMITTED', amount },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
    type: 'DISPOSAL_REQUEST', title: 'Disposal requires approval',
    body: `Disposal ${d.disposal_no} for ${asset.asset_no} (${amount.toLocaleString()} UGX)`,
    entityType: 'assets.disposals', entityId: disposalId, severity: d.requires_dual_control ? 'WARN' : 'INFO',
  });
  return { disposalId, status: 'SUBMITTED', amount, requiresDualControl: d.requires_dual_control };
}

/** Advance a disposal through the controlled review stages. */
export async function setDisposalStage(client: pg.PoolClient, ctx: Ctx, disposalId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_disposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const d = res.rows[0];
  const stage = s(b.stage) ? String(b.stage).toUpperCase() : null;
  if (!stage || !DISPOSAL_STAGES.includes(stage)) throw badRequest(`stage must be one of ${DISPOSAL_STAGES.join(', ')}`);
  const idx = DISPOSAL_STAGES.indexOf(stage);
  if (d.status === 'DRAFT' || d.status === 'COMPLETED' || d.status === 'REJECTED' || d.status === 'CANCELLED') {
    throw badRequest(`Disposal cannot advance to ${stage} from ${d.status}`);
  }
  const currentIdx = d.status === 'SUBMITTED' ? -1 : DISPOSAL_STAGES.indexOf(d.status);
  if (idx <= currentIdx) throw badRequest(`Disposal is already past ${stage}`);
  const asset = await loadAsset(client, ctx, Number(d.asset_id));
  const valuation = n(b.valuation) ?? d.valuation;
  await client.query(
    `UPDATE asset_disposals SET status = $2, valuation = COALESCE($3, valuation),
            notes = COALESCE($4, notes), updated_by = $5 WHERE id = $1`,
    [disposalId, stage, valuation, s(b.notes) ?? null, ctx.userId ?? null]
  );
  await timeline(client, ctx, Number(asset.id), {
    eventType: `DISPOSAL_${stage}`, title: `Disposal in ${stage.toLowerCase()}`,
    description: `Disposal ${d.disposal_no} advanced to ${stage}`,
    oldValue: d.status, newValue: stage, reason: s(b.notes),
    metadata: { disposalId, valuation },
  });
  await logAudit(client, ctx, {
    action: 'stage', resource: 'assets.disposals', recordId: disposalId, recordCode: String(d.disposal_no),
    oldValues: { status: d.status }, newValues: { status: stage, valuation },
  });
  return { disposalId, status: stage, valuation };
}

export async function cancelDisposal(client: pg.PoolClient, ctx: Ctx, disposalId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_disposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [disposalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset disposal not found');
  const d = res.rows[0];
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(d.status)) {
    throw badRequest(`Disposal cannot be cancelled from status ${d.status}`);
  }
  await client.query('UPDATE asset_disposals SET status = $2, notes = COALESCE($3, notes), updated_by = $4 WHERE id = $1', [
    disposalId, 'CANCELLED', s(b.reason) ?? null, ctx.userId ?? null,
  ]);
  const asset = await loadAsset(client, ctx, Number(d.asset_id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'DISPOSAL_CANCELLED', title: 'Disposal cancelled',
    description: `Disposal ${d.disposal_no} cancelled`,
    oldValue: d.status, newValue: 'CANCELLED', reason: s(b.reason),
    metadata: { disposalId },
  });
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'assets.disposals', recordId: disposalId, recordCode: String(d.disposal_no),
    oldValues: { status: d.status }, newValues: { status: 'CANCELLED' }, metadata: { reason: s(b.reason) },
  });
  return { disposalId, status: 'CANCELLED' };
}
// ------------------------------------------------------------
// Depreciation: STRAIGHT_LINE / REDUCING_BALANCE /
// UNITS_OF_PRODUCTION / CUSTOM with period posting, GL
// integration (Dr 6500 / Cr 1620) and schedule projection.
// ------------------------------------------------------------
const DEPR_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM', 'NONE'];
const DEPR_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'];

function periodBounds(frequency: string, periodStart: string): { start: string; end: string } {
  const d = new Date(`${periodStart.slice(0, 10)}T00:00:00`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (frequency === 'QUARTERLY') {
    const qm = Math.floor(m / 3) * 3;
    const start = new Date(Date.UTC(y, qm, 1));
    const end = new Date(Date.UTC(y, qm + 3, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (frequency === 'ANNUAL') {
    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y, 11, 31));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function monthsBetween(a: string, b: string): number {
  const d1 = new Date(`${a}T00:00:00`);
  const d2 = new Date(`${b}T00:00:00`);
  return Math.max(1, (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth()) + 1);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export async function listDepreciations(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['d.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`d.company_id = $${params.length}`); }
  if (n(q.assetId)) { params.push(n(q.assetId)); where.push(`d.asset_id = $${params.length}`); }
  if (s(q.method)) { params.push(String(q.method).toUpperCase()); where.push(`d.method = $${params.length}`); }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 50, 1), 200);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT d.*, a.asset_no, a.name AS asset_name, a.purchase_cost, a.current_book_value,
            a.accumulated_depreciation, a.capitalization_date
     FROM asset_depreciation d JOIN asset_register a ON a.id = d.asset_id
     WHERE ${where.join(' AND ')}
     ORDER BY d.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM asset_depreciation d JOIN asset_register a ON a.id = d.asset_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}

export async function getDepreciationSchedule(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const asset = await loadAsset(client, ctx, assetId);
  const cfgRes = await client.query(
    `SELECT * FROM asset_depreciation WHERE asset_id = $1 AND tenant_id = $2`,
    [assetId, ctx.tenantId]
  );
  const cfg = cfgRes.rows[0] ?? null;
  const entries = await client.query(
    `SELECT * FROM asset_depreciation_entries WHERE asset_id = $1 ORDER BY period_start DESC LIMIT 120`,
    [assetId]
  );
  const projected: Array<{ periodStart: string; periodEnd: string; amount: number; bookValue: number }> = [];
  if (cfg && cfg.method !== 'NONE' && cfg.useful_life_months) {
    const cost = num0(asset.purchase_cost);
    const residual = num0(cfg.residual_value);
    const life = Number(cfg.useful_life_months);
    let start = cfg.last_posted_period
      ? addMonths(String(cfg.last_posted_period).slice(0, 10), 1)
      : (cfg.start_date ?? asset.capitalization_date ?? new Date().toISOString().slice(0, 10));
    let book = num0(asset.current_book_value);
    for (let i = 0; i < 48; i++) {
      const { start: ps, end: pe } = periodBounds(String(cfg.frequency ?? 'MONTHLY'), start);
      const months = monthsBetween(ps, pe);
      let amount = 0;
      if (cfg.method === 'STRAIGHT_LINE') amount = ((cost - residual) / life) * months;
      else if (cfg.method === 'REDUCING_BALANCE') amount = book * (2 / life) * (months / 12);
      else amount = ((cost - residual) / life) * months;
      amount = Math.min(Number(amount.toFixed(2)), Math.max(0, book - residual));
      if (amount <= 0) break;
      book = Number((book - amount).toFixed(2));
      projected.push({ periodStart: ps, periodEnd: pe, amount, bookValue: book });
      start = addMonths(ps, months);
    }
  }
  return { assetId, assetNo: asset.asset_no, assetName: asset.name, config: cfg, posted: entries.rows, projected };
}

export async function setupDepreciation(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  if (['DISPOSED', 'RETIRED', 'ARCHIVED'].includes(asset.status)) {
    throw badRequest(`Depreciation cannot be configured for ${asset.status.toLowerCase()} assets`);
  }
  const method = s(b.method) ? String(b.method).toUpperCase() : 'STRAIGHT_LINE';
  if (!DEPR_METHODS.includes(method)) throw badRequest(`Invalid depreciation method: ${method}`);
  const frequency = s(b.frequency) ? String(b.frequency).toUpperCase() : 'MONTHLY';
  if (!DEPR_FREQUENCIES.includes(frequency)) throw badRequest(`Invalid frequency: ${frequency}`);
  const usefulLifeMonths = method === 'NONE' ? null : n(b.usefulLifeMonths) ?? n(b.useful_life_years) != null ? Math.round(Number(b.useful_life_years) * 12) : n(asset.useful_life_months);
  if (method !== 'NONE' && !usefulLifeMonths) throw badRequest('usefulLifeMonths is required for depreciation');
  const residual = n(b.residualValue) ?? num0(asset.residual_value);
  const startDate = s(b.startDate) ?? s(asset.capitalization_date) ?? new Date().toISOString().slice(0, 10);
  const existing = await client.query('SELECT id FROM asset_depreciation WHERE asset_id = $1', [assetId]);
  let configId: number;
  if (existing.rows.length) {
    await client.query(
      `UPDATE asset_depreciation
          SET method = $2, useful_life_months = $3, residual_value = $4, start_date = $5,
              frequency = $6, is_active = true, updated_by = $7
        WHERE id = $1`,
      [existing.rows[0].id, method, usefulLifeMonths, residual, startDate, frequency, ctx.userId ?? null]
    );
    configId = Number(existing.rows[0].id);
  } else {
    const ins = await client.query(
      `INSERT INTO asset_depreciation
         (company_id, tenant_id, asset_id, method, useful_life_months, residual_value, start_date, frequency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.companyId, ctx.tenantId, assetId, method, usefulLifeMonths, residual, startDate, frequency, ctx.userId ?? null]
    );
    configId = Number(ins.rows[0].id);
  }
  await client.query(
    `UPDATE asset_register
        SET depreciation_method = $2, useful_life_months = $3, residual_value = $4, updated_by = $5
      WHERE id = $1`,
    [assetId, method, usefulLifeMonths, residual, ctx.userId ?? null]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'DEPRECIATION_CONFIGURED', title: 'Depreciation configured',
    description: `${method} over ${usefulLifeMonths ?? 0} months, residual ${residual}`,
    oldValue: asset.depreciation_method, newValue: method,
    metadata: { configId, frequency, residual },
  });
  await logAudit(client, ctx, {
    action: 'setup', resource: 'assets.depreciation', recordId: assetId, recordCode: asset.asset_no,
    newValues: { configId, method, usefulLifeMonths, residual, frequency },
  });
  return { configId, assetId, method, usefulLifeMonths, residual, frequency };
}

async function postDepreciationCore(
  client: pg.PoolClient,
  ctx: Ctx,
  asset: Record<string, unknown>,
  cfg: Record<string, unknown>,
  periodStart: string,
  periodEnd: string,
  overrides: { amount?: number | null; unitsProduced?: number | null } = {}
) {
  const dup = await client.query(
    `SELECT id FROM asset_depreciation_entries WHERE asset_id = $1 AND period_start = $2`,
    [asset.id, periodStart]
  );
  if (dup.rows.length) return { entryId: Number(dup.rows[0].id), duplicate: true };

  const cost = num0(asset.purchase_cost);
  const residual = num0(cfg.residual_value ?? asset.residual_value);
  const life = n(cfg.useful_life_months) ?? 0;
  const book = num0(asset.current_book_value);
  const method = String(cfg.method ?? asset.depreciation_method ?? 'STRAIGHT_LINE');
  const months = monthsBetween(periodStart, periodEnd);
  let amount = 0;
  if (overrides.amount != null) {
    amount = overrides.amount;
  } else if (method === 'STRAIGHT_LINE' && life > 0) {
    amount = ((cost - residual) / life) * months;
  } else if (method === 'REDUCING_BALANCE' && life > 0) {
    amount = book * (2 / life) * (months / 12);
  } else if (method === 'UNITS_OF_PRODUCTION') {
    const attrs = (asset.attributes ?? {}) as Record<string, unknown>;
    const totalUnits = n(overrides.unitsProduced) != null && n(attrs.total_units) != null
      ? n(attrs.total_units) : n(attrs.total_units);
    const units = overrides.unitsProduced ?? n(attrs.units_produced_this_period) ?? 0;
    if (totalUnits && Number(totalUnits) > 0) {
      amount = ((cost - residual) * (units ?? 0)) / Number(totalUnits);
    } else if (life > 0) {
      amount = ((cost - residual) / life) * months;
    }
  } else if (method === 'CUSTOM') {
    throw badRequest('CUSTOM depreciation requires an explicit amount');
  }
  const maxAmount = Math.max(0, book - residual);
  amount = Math.min(Number(amount.toFixed(2)), maxAmount);
  if (amount <= 0) throw badRequest(`No depreciation to post for ${asset.asset_no} (book value ${book} is at or below residual ${residual})`);

  const expId = await finance.getAccountId(client, ctx, '6500');
  const accDepId = await finance.getAccountId(client, ctx, '1620');
  const glJournalId = await finance.postJournalLines(client, ctx, {
    entryDate: periodEnd,
    journalType: 'ASSET_DEPRECIATION',
    description: `Depreciation ${periodStart}..${periodEnd} - ${asset.asset_no}`,
    lines: [
      { account_id: expId, debit: amount, description: `Depreciation - ${asset.asset_no}` },
      { account_id: accDepId, credit: amount, description: `Accumulated depreciation - ${asset.asset_no}` },
    ],
    refType: 'asset_depreciation_entries',
    refCode: String(asset.asset_no),
  });

  const newAccDep = Number((num0(asset.accumulated_depreciation) + amount).toFixed(2));
  const newBook = Number((cost - newAccDep).toFixed(2));
  await client.query(
    `UPDATE asset_register
        SET accumulated_depreciation = $2, current_book_value = $3, updated_by = $4
      WHERE id = $1`,
    [asset.id, newAccDep, newBook, ctx.userId ?? null]
  );
  await client.query(
    `UPDATE asset_depreciation SET last_posted_period = $2, updated_by = $3 WHERE id = $1`,
    [cfg.id, periodStart, ctx.userId ?? null]
  );
  const ins = await client.query(
    `INSERT INTO asset_depreciation_entries
       (company_id, tenant_id, asset_id, period_start, period_end, amount,
        accumulated_depreciation, book_value, gl_journal_id, posted_at, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10) RETURNING id`,
    [ctx.companyId, ctx.tenantId, asset.id, periodStart, periodEnd, amount, newAccDep, newBook, glJournalId, ctx.userId ?? null]
  );
  const entryId = Number(ins.rows[0].id);
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'DEPRECIATED', title: 'Depreciation posted',
    description: `${method} ${amount.toLocaleString()} for ${periodStart}..${periodEnd}`,
    oldValue: String(num0(asset.accumulated_depreciation)), newValue: String(newAccDep),
    metadata: { entryId, amount, periodStart, periodEnd, glJournalId },
  });
  await logAudit(client, ctx, {
    action: 'post_depreciation', resource: 'assets.depreciation', recordId: entryId, recordCode: String(asset.asset_no),
    newValues: { amount, periodStart, periodEnd, accumulated_depreciation: newAccDep, book_value: newBook, gl_journal_id: glJournalId },
  });
  await emitEvent(client, ctx, {
    eventType: 'assets.depreciation_posted', entityType: 'assets.register',
    entityId: Number(asset.id), entityCode: String(asset.asset_no),
    payload: { entryId, amount, periodStart, periodEnd },
  });
  return { entryId, amount, periodStart, periodEnd, accumulatedDepreciation: newAccDep, bookValue: newBook, glJournalId, duplicate: false };
}

export async function postDepreciation(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const cfgRes = await client.query(
    `SELECT * FROM asset_depreciation WHERE asset_id = $1 AND tenant_id = $2`,
    [assetId, ctx.tenantId]
  );
  if (cfgRes.rows.length === 0) throw badRequest('Depreciation has not been configured for this asset');
  const cfg = cfgRes.rows[0];
  if (!cfg.is_active || cfg.method === 'NONE') throw badRequest('Depreciation is inactive for this asset');
  const periodStart = s(b.periodStart) ?? addMonths(String(cfg.last_posted_period ?? cfg.start_date ?? new Date().toISOString().slice(0, 10)), 1);
  const periodEnd = s(b.periodEnd) ?? periodBounds(String(cfg.frequency), periodStart).end;
  return postDepreciationCore(client, ctx, asset, cfg, periodStart, periodEnd, {
    amount: n(b.amount),
    unitsProduced: n(b.unitsProduced) ?? n(b.units),
  });
}

export async function runDepreciation(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const periodStart = s(b.periodStart) ?? new Date().toISOString().slice(0, 10);
  const configs = await client.query(
    `SELECT d.*, a.asset_no, a.name AS asset_name
     FROM asset_depreciation d JOIN asset_register a ON a.id = d.asset_id
     WHERE d.tenant_id = $1 AND d.company_id = $2 AND d.is_active AND d.method <> 'NONE'
       AND (d.last_posted_period IS NULL OR d.last_posted_period < $3::date)
     ORDER BY a.asset_no`,
    [ctx.tenantId, ctx.companyId, periodStart]
  );
  const results: Array<Record<string, unknown>> = [];
  let errors: Array<Record<string, unknown>> = [];
  for (const cfg of configs.rows) {
    try {
      const asset = await loadAsset(client, ctx, Number(cfg.asset_id));
      if (['DISPOSED', 'RETIRED', 'ARCHIVED'].includes(asset.status)) continue;
      const { start: ps, end: pe } = periodBounds(String(cfg.frequency), periodStart);
      const out = await postDepreciationCore(client, ctx, asset, cfg, ps, pe, {
        amount: n(b.amount), unitsProduced: n(b.unitsProduced),
      });
      results.push({ assetNo: cfg.asset_no, ...out });
    } catch (err) {
      errors.push({ assetNo: cfg.asset_no, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (errors.length) {
    errors = errors.filter((e) => !/No depreciation to post/.test(String(e.error)));
  }
  return { periodStart, processed: configs.rows.length, posted: results, errors };
}
// ------------------------------------------------------------
// Impairment / reversal / revaluation (DRAFT -> SUBMITTED ->
// APPROVED -> POSTED). Posting handled by approveImpairment.
// ------------------------------------------------------------
const IMPAIRMENT_TYPES = ['IMPAIRMENT', 'REVERSAL', 'REVALUATION'];

export async function listImpairments(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['i.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`i.company_id = $${params.length}`); }
  if (n(q.assetId)) { params.push(n(q.assetId)); where.push(`i.asset_id = $${params.length}`); }
  if (s(q.status)) { params.push(String(q.status).toUpperCase()); where.push(`i.status = $${params.length}`); }
  if (s(q.type)) { params.push(String(q.type).toUpperCase()); where.push(`i.impairment_type = $${params.length}`); }
  if (s(q.search)) {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where.push(`(lower(i.impairment_no) LIKE $${params.length} OR lower(a.asset_no) LIKE $${params.length} OR lower(a.name) LIKE $${params.length})`);
  }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 200);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT i.*, a.asset_no, a.name AS asset_name
     FROM asset_impairments i JOIN asset_register a ON a.id = i.asset_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM asset_impairments i JOIN asset_register a ON a.id = i.asset_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}

export async function getImpairment(client: pg.PoolClient, ctx: Ctx, impairmentId: number) {
  const res = await client.query(
    `SELECT i.*, a.asset_no, a.name AS asset_name
     FROM asset_impairments i JOIN asset_register a ON a.id = i.asset_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [impairmentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset impairment not found');
  return res.rows[0];
}

export async function createImpairment(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, Number(b.assetId));
  if (!asset) throw badRequest('assetId is required');
  if (['DISPOSED', 'RETIRED', 'ARCHIVED'].includes(asset.status)) {
    throw badRequest(`Impairment cannot be created for ${asset.status.toLowerCase()} assets`);
  }
  const impairmentType = s(b.impairmentType) ? String(b.impairmentType).toUpperCase() : 'IMPAIRMENT';
  if (!IMPAIRMENT_TYPES.includes(impairmentType)) throw badRequest(`Invalid impairment type: ${impairmentType}`);
  const oldBookValue = n(b.oldBookValue) ?? num0(asset.current_book_value);
  const newBookValue = n(b.newBookValue);
  if (newBookValue == null) throw badRequest('newBookValue is required');
  if (impairmentType === 'REVERSAL' && newBookValue <= oldBookValue) {
    throw badRequest('Reversal must increase the book value above the current value');
  }
  if (impairmentType === 'IMPAIRMENT' && newBookValue >= oldBookValue) {
    throw badRequest('Impairment must reduce the book value below the current value');
  }
  const impairmentNo = await nextNo(client, ctx, 'IM');
  const res = await client.query(
    `INSERT INTO asset_impairments
       (company_id, tenant_id, asset_id, impairment_no, impairment_type, old_book_value,
        new_book_value, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.companyId, ctx.tenantId, asset.id, impairmentNo, impairmentType, oldBookValue, newBookValue, s(b.reason) ?? null, ctx.userId ?? null]
  );
  const impairmentId = Number(res.rows[0].id);
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'IMPAIRMENT_REQUESTED', title: `${impairmentType} requested`,
    description: `${impairmentType} ${impairmentNo}: ${oldBookValue} -> ${newBookValue}`,
    oldValue: String(oldBookValue), newValue: String(newBookValue), reason: s(b.reason),
    metadata: { impairmentId },
  });
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.impairments', recordId: impairmentId, recordCode: impairmentNo,
    newValues: { impairmentType, oldBookValue, newBookValue },
  });
  return { impairmentId, impairmentNo, impairmentType, oldBookValue, newBookValue, status: 'DRAFT' };
}

export async function submitImpairment(client: pg.PoolClient, ctx: Ctx, impairmentId: number) {
  const res = await client.query(
    'SELECT * FROM asset_impairments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [impairmentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset impairment not found');
  const imp = res.rows[0];
  if (imp.status !== 'DRAFT') throw badRequest(`Impairment can only be submitted from DRAFT (current: ${imp.status})`);
  const asset = await loadAsset(client, ctx, Number(imp.asset_id));
  const delta = Math.abs(num0(imp.old_book_value) - num0(imp.new_book_value));
  await client.query('UPDATE asset_impairments SET status = $2, updated_by = $3 WHERE id = $1', [impairmentId, 'SUBMITTED', ctx.userId ?? null]);
  await startWorkflow(client, ctx, {
    entityType: 'assets.impairments', entityId: impairmentId,
    entityCode: String(imp.impairment_no), amount: delta,
    companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'IMPAIRMENT_SUBMITTED', title: 'Impairment submitted for approval',
    description: `${imp.impairment_no} submitted (${imp.impairment_type})`,
    oldValue: 'DRAFT', newValue: 'SUBMITTED', metadata: { impairmentId, delta },
  });
  await logAudit(client, ctx, {
    action: 'submit', resource: 'assets.impairments', recordId: impairmentId, recordCode: String(imp.impairment_no),
    newValues: { status: 'SUBMITTED', delta },
  });
  await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
    type: 'IMPAIRMENT_REQUEST', title: 'Impairment requires approval',
    body: `${imp.impairment_type} ${imp.impairment_no} for ${asset.asset_no} (${delta.toLocaleString()} UGX)`,
    entityType: 'assets.impairments', entityId: impairmentId, severity: 'INFO',
  });
  return { impairmentId, status: 'SUBMITTED', delta };
}

export async function cancelImpairment(client: pg.PoolClient, ctx: Ctx, impairmentId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_impairments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [impairmentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset impairment not found');
  const imp = res.rows[0];
  if (['POSTED', 'REJECTED'].includes(imp.status)) throw badRequest(`Impairment cannot be cancelled from status ${imp.status}`);
  await client.query('UPDATE asset_impairments SET status = $2, updated_by = $3 WHERE id = $1', [impairmentId, 'REJECTED', ctx.userId ?? null]);
  const asset = await loadAsset(client, ctx, Number(imp.asset_id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'IMPAIRMENT_CANCELLED', title: 'Impairment cancelled',
    description: `${imp.impairment_no} cancelled`,
    oldValue: imp.status, newValue: 'REJECTED', reason: s(b.reason),
    metadata: { impairmentId },
  });
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'assets.impairments', recordId: impairmentId, recordCode: String(imp.impairment_no),
    oldValues: { status: imp.status }, newValues: { status: 'REJECTED' }, metadata: { reason: s(b.reason) },
  });
  return { impairmentId, status: 'REJECTED' };
}
// ------------------------------------------------------------
// Warranty & insurance management with asset-level status sync
// (IN_WARRANTY / EXPIRING_SOON / EXPIRED) and expiry alerts.
// ------------------------------------------------------------
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function syncWarrantyStatus(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const res = await client.query(
    `SELECT start_date, end_date FROM asset_warranties
     WHERE asset_id = $1 AND tenant_id = $2 AND is_active
     ORDER BY end_date ASC NULLS LAST`,
    [assetId, ctx.tenantId]
  );
  const today = new Date().toISOString().slice(0, 10);
  let status = 'NONE';
  for (const w of res.rows) {
    const end = w.end_date ? String(w.end_date).slice(0, 10) : null;
    if (end && end < today) { status = 'EXPIRED'; break; }
    if (end && end <= addDays(today, 90)) { status = 'EXPIRING_SOON'; break; }
    status = 'IN_WARRANTY';
  }
  await client.query('UPDATE asset_register SET warranty_status = $2, updated_by = $3 WHERE id = $1', [
    assetId, status, ctx.userId ?? null,
  ]);
  return status;
}

async function syncInsuranceStatus(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const res = await client.query(
    `SELECT start_date, end_date FROM asset_insurance
     WHERE asset_id = $1 AND tenant_id = $2 AND is_active
     ORDER BY end_date ASC NULLS LAST`,
    [assetId, ctx.tenantId]
  );
  const today = new Date().toISOString().slice(0, 10);
  let status = 'NONE';
  for (const w of res.rows) {
    const end = w.end_date ? String(w.end_date).slice(0, 10) : null;
    if (end && end < today) { status = 'EXPIRED'; break; }
    if (end && end <= addDays(today, 90)) { status = 'EXPIRING_SOON'; break; }
    status = 'INSURED';
  }
  await client.query('UPDATE asset_register SET insurance_status = $2, updated_by = $3 WHERE id = $1', [
    assetId, status, ctx.userId ?? null,
  ]);
  return status;
}

async function warrantyExpiryAlert(client: pg.PoolClient, ctx: Ctx, asset: Record<string, unknown>, endDate: string | null | undefined) {
  if (!endDate) return;
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.floor((new Date(`${String(endDate).slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000);
  if (days < 0) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
      type: 'WARRANTY_EXPIRED', title: 'Warranty expired',
      body: `Warranty for ${asset.asset_no} (${asset.name}) expired on ${String(endDate).slice(0, 10)}`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'WARN',
    });
  } else if (days <= 30) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
      type: 'WARRANTY_EXPIRING', title: 'Warranty expires soon',
      body: `Warranty for ${asset.asset_no} (${asset.name}) expires in ${days} day(s)`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'INFO',
    });
  } else if (days <= 90) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager'], {
      type: 'WARRANTY_EXPIRING', title: 'Warranty expiring in 90 days',
      body: `Warranty for ${asset.asset_no} (${asset.name}) expires on ${String(endDate).slice(0, 10)}`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'INFO',
    });
  }
}

async function insuranceExpiryAlert(client: pg.PoolClient, ctx: Ctx, asset: Record<string, unknown>, endDate: string | null | undefined) {
  if (!endDate) return;
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.floor((new Date(`${String(endDate).slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000);
  if (days < 0) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
      type: 'INSURANCE_EXPIRED', title: 'Insurance expired',
      body: `Insurance for ${asset.asset_no} (${asset.name}) expired on ${String(endDate).slice(0, 10)}`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'WARN',
    });
  } else if (days <= 30) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
      type: 'INSURANCE_EXPIRING', title: 'Insurance expires soon',
      body: `Insurance for ${asset.asset_no} (${asset.name}) expires in ${days} day(s)`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'INFO',
    });
  } else if (days <= 90) {
    await notifyRoleAdvanced(client, ctx, ['asset_manager', 'asset_finance'], {
      type: 'INSURANCE_EXPIRING', title: 'Insurance expiring in 90 days',
      body: `Insurance for ${asset.asset_no} (${asset.name}) expires on ${String(endDate).slice(0, 10)}`,
      entityType: 'assets.register', entityId: Number(asset.id), severity: 'INFO',
    });
  }
}

export async function listWarranties(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['w.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`w.company_id = $${params.length}`); }
  if (n(q.assetId)) { params.push(n(q.assetId)); where.push(`w.asset_id = $${params.length}`); }
  if (q.active === '1' || q.active === 'true') where.push('w.is_active');
  if (s(q.search)) {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where.push(`(lower(w.provider) LIKE $${params.length} OR lower(a.asset_no) LIKE $${params.length} OR lower(a.name) LIKE $${params.length})`);
  }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 200);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT w.*, a.asset_no, a.name AS asset_name
     FROM asset_warranties w JOIN asset_register a ON a.id = w.asset_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.end_date ASC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM asset_warranties w JOIN asset_register a ON a.id = w.asset_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}

export async function getWarranty(client: pg.PoolClient, ctx: Ctx, warrantyId: number) {
  const res = await client.query(
    `SELECT w.*, a.asset_no, a.name AS asset_name
     FROM asset_warranties w JOIN asset_register a ON a.id = w.asset_id
     WHERE w.id = $1 AND w.tenant_id = $2`,
    [warrantyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset warranty not found');
  return res.rows[0];
}

export async function createWarranty(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, Number(b.assetId));
  if (!asset) throw badRequest('assetId is required');
  const provider = s(b.provider);
  if (!provider) throw badRequest('provider is required');
  const res = await client.query(
    `INSERT INTO asset_warranties
       (company_id, tenant_id, asset_id, provider, warranty_no, start_date, end_date,
        coverage, terms, contact_name, contact_phone, contact_email, claim_history, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, asset.id, provider, s(b.warrantyNo), s(b.startDate), s(b.endDate),
      s(b.coverage), s(b.terms), s(b.contactName), s(b.contactPhone), s(b.contactEmail),
      Array.isArray(b.claims) ? JSON.stringify(b.claims) : '[]', ctx.userId ?? null,
    ]
  );
  const warrantyId = Number(res.rows[0].id);
  const status = await syncWarrantyStatus(client, ctx, Number(asset.id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'WARRANTY_ADDED', title: 'Warranty recorded',
    description: `${provider} warranty ${s(b.warrantyNo) ?? ''} ${s(b.startDate) ? `${b.startDate} to ` : ''}${s(b.endDate) ?? 'open-ended'}`,
    metadata: { warrantyId, endDate: s(b.endDate) },
  });
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.warranties', recordId: warrantyId, recordCode: asset.asset_no,
    newValues: { provider, warrantyNo: s(b.warrantyNo), startDate: s(b.startDate), endDate: s(b.endDate) },
  });
  await warrantyExpiryAlert(client, ctx, asset, s(b.endDate));
  return { warrantyId, assetId: Number(asset.id), status };
}

export async function updateWarranty(client: pg.PoolClient, ctx: Ctx, warrantyId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_warranties WHERE id = $1 AND tenant_id = $2',
    [warrantyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset warranty not found');
  const w = res.rows[0];
  await client.query(
    `UPDATE asset_warranties
        SET provider = COALESCE($2, provider), warranty_no = COALESCE($3, warranty_no),
            start_date = COALESCE($4, start_date), end_date = COALESCE($5, end_date),
            coverage = COALESCE($6, coverage), terms = COALESCE($7, terms),
            contact_name = COALESCE($8, contact_name), contact_phone = COALESCE($9, contact_phone),
            contact_email = COALESCE($10, contact_email),
            claim_history = COALESCE($11::jsonb, claim_history), updated_by = $12
      WHERE id = $1`,
    [
      warrantyId, s(b.provider), s(b.warrantyNo), s(b.startDate), s(b.endDate), s(b.coverage),
      s(b.terms), s(b.contactName), s(b.contactPhone), s(b.contactEmail),
      Array.isArray(b.claims) ? JSON.stringify(b.claims) : null, ctx.userId ?? null,
    ]
  );
  const asset = await loadAsset(client, ctx, Number(w.asset_id));
  const status = await syncWarrantyStatus(client, ctx, Number(asset.id));
  await logAudit(client, ctx, {
    action: 'update', resource: 'assets.warranties', recordId: warrantyId, recordCode: asset.asset_no,
    oldValues: { end_date: w.end_date }, newValues: { endDate: s(b.endDate), status },
  });
  await warrantyExpiryAlert(client, ctx, asset, s(b.endDate) ?? (w.end_date ? String(w.end_date) : null));
  return { warrantyId, status };
}

export async function deactivateWarranty(client: pg.PoolClient, ctx: Ctx, warrantyId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_warranties WHERE id = $1 AND tenant_id = $2',
    [warrantyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset warranty not found');
  const w = res.rows[0];
  await client.query('UPDATE asset_warranties SET is_active = false, updated_by = $2 WHERE id = $1', [
    warrantyId, ctx.userId ?? null,
  ]);
  const asset = await loadAsset(client, ctx, Number(w.asset_id));
  const status = await syncWarrantyStatus(client, ctx, Number(asset.id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'WARRANTY_DEACTIVATED', title: 'Warranty deactivated',
    description: `Warranty from ${w.provider} deactivated`, reason: s(b.reason),
    metadata: { warrantyId },
  });
  await logAudit(client, ctx, {
    action: 'deactivate', resource: 'assets.warranties', recordId: warrantyId, recordCode: asset.asset_no,
    newValues: { is_active: false, status }, metadata: { reason: s(b.reason) },
  });
  return { warrantyId, status };
}

export async function listInsurance(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['i.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`i.company_id = $${params.length}`); }
  if (n(q.assetId)) { params.push(n(q.assetId)); where.push(`i.asset_id = $${params.length}`); }
  if (q.active === '1' || q.active === 'true') where.push('i.is_active');
  if (s(q.search)) {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where.push(`(lower(i.provider) LIKE $${params.length} OR lower(i.policy_no) LIKE $${params.length} OR lower(a.asset_no) LIKE $${params.length})`);
  }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 200);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT i.*, a.asset_no, a.name AS asset_name
     FROM asset_insurance i JOIN asset_register a ON a.id = i.asset_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.end_date ASC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM asset_insurance i JOIN asset_register a ON a.id = i.asset_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}

export async function getInsurance(client: pg.PoolClient, ctx: Ctx, insuranceId: number) {
  const res = await client.query(
    `SELECT i.*, a.asset_no, a.name AS asset_name
     FROM asset_insurance i JOIN asset_register a ON a.id = i.asset_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [insuranceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset insurance not found');
  return res.rows[0];
}

export async function createInsurance(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, Number(b.assetId));
  if (!asset) throw badRequest('assetId is required');
  const provider = s(b.provider);
  const policyNo = s(b.policyNo);
  if (!provider) throw badRequest('provider is required');
  if (!policyNo) throw badRequest('policyNo is required');
  const res = await client.query(
    `INSERT INTO asset_insurance
       (company_id, tenant_id, asset_id, provider, policy_no, start_date, end_date,
        coverage, premium, insured_value, claims, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, asset.id, provider, policyNo, s(b.startDate), s(b.endDate),
      s(b.coverage), n(b.premium) ?? 0, n(b.insuredValue) ?? 0,
      Array.isArray(b.claims) ? JSON.stringify(b.claims) : '[]', ctx.userId ?? null,
    ]
  );
  const insuranceId = Number(res.rows[0].id);
  const status = await syncInsuranceStatus(client, ctx, Number(asset.id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'INSURANCE_ADDED', title: 'Insurance recorded',
    description: `${provider} policy ${policyNo} insured for ${(n(b.insuredValue) ?? 0).toLocaleString()}`,
    metadata: { insuranceId, endDate: s(b.endDate) },
  });
  await logAudit(client, ctx, {
    action: 'create', resource: 'assets.insurance', recordId: insuranceId, recordCode: policyNo,
    newValues: { provider, policyNo, startDate: s(b.startDate), endDate: s(b.endDate), insuredValue: n(b.insuredValue) },
  });
  await insuranceExpiryAlert(client, ctx, asset, s(b.endDate));
  return { insuranceId, assetId: Number(asset.id), status };
}

export async function updateInsurance(client: pg.PoolClient, ctx: Ctx, insuranceId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_insurance WHERE id = $1 AND tenant_id = $2',
    [insuranceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset insurance not found');
  const ins = res.rows[0];
  await client.query(
    `UPDATE asset_insurance
        SET provider = COALESCE($2, provider), policy_no = COALESCE($3, policy_no),
            start_date = COALESCE($4, start_date), end_date = COALESCE($5, end_date),
            coverage = COALESCE($6, coverage), premium = COALESCE($7, premium),
            insured_value = COALESCE($8, insured_value),
            claims = COALESCE($9::jsonb, claims), updated_by = $10
      WHERE id = $1`,
    [
      insuranceId, s(b.provider), s(b.policyNo), s(b.startDate), s(b.endDate), s(b.coverage),
      n(b.premium) ?? null, n(b.insuredValue) ?? null,
      Array.isArray(b.claims) ? JSON.stringify(b.claims) : null, ctx.userId ?? null,
    ]
  );
  const asset = await loadAsset(client, ctx, Number(ins.asset_id));
  const status = await syncInsuranceStatus(client, ctx, Number(asset.id));
  await logAudit(client, ctx, {
    action: 'update', resource: 'assets.insurance', recordId: insuranceId, recordCode: String(ins.policy_no),
    oldValues: { end_date: ins.end_date }, newValues: { endDate: s(b.endDate), status },
  });
  await insuranceExpiryAlert(client, ctx, asset, s(b.endDate) ?? (ins.end_date ? String(ins.end_date) : null));
  return { insuranceId, status };
}

export async function deactivateInsurance(client: pg.PoolClient, ctx: Ctx, insuranceId: number, b: Record<string, unknown>) {
  const res = await client.query(
    'SELECT * FROM asset_insurance WHERE id = $1 AND tenant_id = $2',
    [insuranceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset insurance not found');
  const ins = res.rows[0];
  await client.query('UPDATE asset_insurance SET is_active = false, updated_by = $2 WHERE id = $1', [
    insuranceId, ctx.userId ?? null,
  ]);
  const asset = await loadAsset(client, ctx, Number(ins.asset_id));
  const status = await syncInsuranceStatus(client, ctx, Number(asset.id));
  await timeline(client, ctx, Number(asset.id), {
    eventType: 'INSURANCE_DEACTIVATED', title: 'Insurance deactivated',
    description: `Policy ${ins.policy_no} deactivated`, reason: s(b.reason),
    metadata: { insuranceId },
  });
  await logAudit(client, ctx, {
    action: 'deactivate', resource: 'assets.insurance', recordId: insuranceId, recordCode: String(ins.policy_no),
    newValues: { is_active: false, status }, metadata: { reason: s(b.reason) },
  });
  return { insuranceId, status };
}
// ------------------------------------------------------------
// Asset documents, photos and comments (versioned document
// records, access-controlled storage, audit logs).
// ------------------------------------------------------------
const ASSET_DOC_CATEGORIES = ['PURCHASE_INVOICE', 'PO', 'WARRANTY', 'MANUAL', 'CERTIFICATE', 'INSURANCE',
  'INSPECTION_CERTIFICATE', 'MAINTENANCE_REPORT', 'TRANSFER_FORM', 'ASSIGNMENT_FORM',
  'DISPOSAL_APPROVAL', 'PHOTO', 'OTHER'];
const ASSET_PHOTO_CATEGORIES = ['FRONT', 'BACK', 'SERIAL_NUMBER', 'QR_TAG', 'CONDITION', 'DAMAGE', 'LOCATION', 'OTHER'];

interface UploadFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

function fileFromBody(b: Record<string, unknown>): UploadFile | null {
  const f = b.file as UploadFile | undefined;
  if (f && (f.buffer || f.originalname)) return f;
  const base64 = s(b.fileBase64);
  if (base64) {
    const buf = Buffer.from(base64, 'base64');
    return { originalname: s(b.fileName) ?? 'asset-document.bin', mimetype: s(b.mimeType) ?? 'application/octet-stream', size: buf.length, buffer: buf };
  }
  return null;
}

export async function listAssetDocuments(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const asset = await loadAsset(client, ctx, assetId);
  const rows = await client.query(
    `SELECT ad.id AS link_id, ad.category, ad.is_primary, ad.created_at AS linked_at,
            d.id AS document_id, d.doc_no, d.title, d.description, d.category AS doc_category,
            d.file_name, d.mime_type, d.file_size, d.storage_key, d.checksum, d.version,
            d.status AS doc_status, d.expires_at, d.created_at
     FROM asset_documents ad
     JOIN documents d ON d.id = ad.document_id
     WHERE ad.asset_id = $1 AND ad.tenant_id = $2
     ORDER BY ad.created_at DESC`,
    [assetId, ctx.tenantId]
  );
  return { assetId, assetNo: asset.asset_no, documents: rows.rows };
}

export async function attachDocument(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const file = fileFromBody(b);
  const storageKey = s(b.storageKey);
  if (!file && !storageKey) throw badRequest('Provide a file upload or an existing storageKey');
  const category = s(b.category) ? String(b.category).toUpperCase() : 'OTHER';
  if (!ASSET_DOC_CATEGORIES.includes(category)) throw badRequest(`Invalid document category: ${category}`);
  const docNo = await nextNo(client, ctx, 'DOC');
  let checksum = '';
  let fileSize = 0;
  let mime = 'application/octet-stream';
  let fileName = 'document';
  if (file?.buffer) {
    fileName = String(file.originalname ?? 'document').replace(/[^A-Za-z0-9._-]+/g, '_');
    mime = String(file.mimetype ?? 'application/octet-stream');
    fileSize = Number(file.size) || file.buffer.length;
    checksum = createHash('sha256').update(file.buffer).digest('hex');
  }
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const resolvedKey = storageKey ?? `assets/${ctx.companyId}/${asset.asset_no}/${docNo}-${safeName}`;
  if (file?.buffer) {
    mkdirSync(path.join(config.storageRoot, path.dirname(resolvedKey)), { recursive: true });
    writeFileSync(path.join(config.storageRoot, resolvedKey), file.buffer);
  }
  const ins = await client.query(
    `INSERT INTO documents
       (company_id, tenant_id, doc_no, title, description, category, file_name, mime_type,
        file_size, storage_key, checksum, status, uploaded_by, expires_at, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SUBMITTED',$12,$13,$14)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, docNo, s(b.title) ?? `${asset.asset_no} document`, s(b.description) ?? null,
      category, fileName, mime, fileSize, resolvedKey, checksum || null, ctx.userId ?? null,
      s(b.expiresAt) ?? null,
      JSON.stringify({ assetNo: asset.asset_no, classification: s(b.classification) ?? 'INTERNAL' }),
    ]
  );
  const documentId = Number(ins.rows[0].id);
  await client.query(
    `INSERT INTO asset_documents (company_id, tenant_id, asset_id, document_id, category, is_primary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (asset_id, document_id) DO UPDATE SET category = EXCLUDED.category`,
    [ctx.companyId, ctx.tenantId, assetId, documentId, category, b.isPrimary === true || b.isPrimary === 'true', ctx.userId ?? null]
  );
  await timeline(client, ctx, assetId, {
    eventType: 'DOCUMENT_ADDED', title: 'Document attached',
    description: `${category} - ${fileName}`,
    referenceDocId: documentId, metadata: { documentId, docNo, category, checksum },
  });
  await logAudit(client, ctx, {
    action: 'upload', resource: 'assets.documents', recordId: assetId, recordCode: asset.asset_no,
    newValues: { documentId, docNo, fileName, category, checksum },
  });
  return { documentId, docNo, fileName, mimeType: mime, sizeBytes: fileSize, checksum, category, storageKey: resolvedKey };
}

export async function removeDocumentLink(client: pg.PoolClient, ctx: Ctx, assetId: number, documentId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const res = await client.query(
    'DELETE FROM asset_documents WHERE asset_id = $1 AND document_id = $2 AND tenant_id = $3 RETURNING id',
    [assetId, documentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Document link not found');
  await timeline(client, ctx, assetId, {
    eventType: 'DOCUMENT_REMOVED', title: 'Document unlinked',
    description: `Document #${documentId} unlinked from asset`, reason: s(b.reason),
    referenceDocId: documentId, metadata: { documentId },
  });
  await logAudit(client, ctx, {
    action: 'remove_document', resource: 'assets.documents', recordId: assetId, recordCode: asset.asset_no,
    oldValues: { documentId }, metadata: { reason: s(b.reason) },
  });
  return { assetId, documentId, removed: true };
}

export async function getAssetDocumentFile(client: pg.PoolClient, ctx: Ctx, assetId: number, documentId: number) {
  const res = await client.query(
    `SELECT d.file_name, d.mime_type, d.storage_key, d.file_size
     FROM asset_documents ad JOIN documents d ON d.id = ad.document_id
     WHERE ad.asset_id = $1 AND ad.document_id = $2 AND ad.tenant_id = $3`,
    [assetId, documentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset document not found');
  const row = res.rows[0];
  const storageKey = String(row.storage_key ?? '');
  if (!storageKey) throw notFound('Document has no stored file');
  const root = path.resolve(config.storageRoot);
  const abs = path.resolve(root, storageKey);
  if (!abs.startsWith(root + path.sep)) throw forbidden('Invalid document path');
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    throw notFound('Document file is missing');
  }
  return {
    buffer,
    fileName: String(row.file_name ?? 'document'),
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    sizeBytes: Number(row.file_size) || buffer.length,
  };
}

export async function listAssetPhotos(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const asset = await loadAsset(client, ctx, assetId);
  const rows = await client.query(
    `SELECT p.*, d.doc_no, d.file_name, d.storage_key, d.mime_type AS doc_mime_type
     FROM asset_photos p LEFT JOIN documents d ON d.id = p.document_id
     WHERE p.asset_id = $1 AND p.tenant_id = $2
     ORDER BY p.created_at DESC`,
    [assetId, ctx.tenantId]
  );
  return { assetId, assetNo: asset.asset_no, photos: rows.rows };
}

export async function attachPhoto(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const file = fileFromBody(b);
  if (!file?.buffer) throw badRequest('A photo file is required');
  const category = s(b.category) ? String(b.category).toUpperCase() : 'OTHER';
  if (!ASSET_PHOTO_CATEGORIES.includes(category)) throw badRequest(`Invalid photo category: ${category}`);
  const docNo = await nextNo(client, ctx, 'DOC');
  const fileName = String(file.originalname ?? `${asset.asset_no}-${category.toLowerCase()}.jpg`).replace(/[^A-Za-z0-9._-]+/g, '_');
  const mime = String(file.mimetype ?? 'image/jpeg');
  const checksum = createHash('sha256').update(file.buffer).digest('hex');
  const storageKey = `assets/${ctx.companyId}/${asset.asset_no}/photos/${docNo}-${fileName}`;
  mkdirSync(path.join(config.storageRoot, path.dirname(storageKey)), { recursive: true });
  writeFileSync(path.join(config.storageRoot, storageKey), file.buffer);
  const docRes = await client.query(
    `INSERT INTO documents
       (company_id, tenant_id, doc_no, title, description, category, file_name, mime_type,
        file_size, storage_key, checksum, status, uploaded_by, attributes)
     VALUES ($1,$2,$3,$4,$5,'PHOTO',$6,$7,$8,$9,$10,'SUBMITTED',$11,$12) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, docNo, `${asset.asset_no} ${category} photo`, s(b.description) ?? null,
      fileName, mime, file.buffer.length, storageKey, checksum, ctx.userId ?? null,
      JSON.stringify({ assetNo: asset.asset_no, category }),
    ]
  );
  const documentId = Number(docRes.rows[0].id);
  const ins = await client.query(
    `INSERT INTO asset_photos (company_id, tenant_id, asset_id, document_id, category, storage_key, mime_type, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.companyId, ctx.tenantId, assetId, documentId, category, storageKey, mime, ctx.userId ?? null]
  );
  const photoId = Number(ins.rows[0].id);
  await timeline(client, ctx, assetId, {
    eventType: 'PHOTO_ADDED', title: 'Photo attached',
    description: `${category} photo - ${fileName}`,
    referenceDocId: documentId, metadata: { photoId, documentId, category },
  });
  await logAudit(client, ctx, {
    action: 'upload', resource: 'assets.photos', recordId: assetId, recordCode: asset.asset_no,
    newValues: { photoId, documentId, fileName, category, checksum },
  });
  return { photoId, documentId, fileName, category, mimeType: mime, storageKey };
}

export async function deletePhoto(client: pg.PoolClient, ctx: Ctx, assetId: number, photoId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const res = await client.query(
    `DELETE FROM asset_photos WHERE id = $1 AND asset_id = $2 AND tenant_id = $3 RETURNING id, document_id`,
    [photoId, assetId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Asset photo not found');
  const documentId = n(res.rows[0].document_id);
  if (documentId) {
    await client.query('UPDATE documents SET status = $2 WHERE id = $1', [documentId, 'ARCHIVED']);
  }
  await timeline(client, ctx, assetId, {
    eventType: 'PHOTO_REMOVED', title: 'Photo removed',
    description: `Photo #${photoId} removed`, reason: s(b.reason),
    referenceDocId: documentId ?? null, metadata: { photoId },
  });
  await logAudit(client, ctx, {
    action: 'delete', resource: 'assets.photos', recordId: assetId, recordCode: asset.asset_no,
    oldValues: { photoId }, metadata: { reason: s(b.reason) },
  });
  return { assetId, photoId, removed: true };
}

export async function listAssetComments(client: pg.PoolClient, ctx: Ctx, assetId: number) {
  const asset = await loadAsset(client, ctx, assetId);
  const rows = await client.query(
    `SELECT c.*, COALESCE(u.first_name || ' ' || u.last_name, '') AS created_by_name
     FROM asset_comments c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.asset_id = $1 AND c.tenant_id = $2
     ORDER BY c.created_at DESC`,
    [assetId, ctx.tenantId]
  );
  return { assetId, assetNo: asset.asset_no, comments: rows.rows };
}

export async function addAssetComment(client: pg.PoolClient, ctx: Ctx, assetId: number, b: Record<string, unknown>) {
  const asset = await loadAsset(client, ctx, assetId);
  const body = s(b.body);
  if (!body) throw badRequest('Comment body is required');
  const parentId = n(b.parentId) ?? null;
  if (parentId) {
    const p = await client.query('SELECT 1 FROM asset_comments WHERE id = $1 AND asset_id = $2', [parentId, assetId]);
    if (p.rows.length === 0) throw badRequest('Parent comment not found');
  }
  const ins = await client.query(
    `INSERT INTO asset_comments (company_id, tenant_id, asset_id, body, parent_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.companyId, ctx.tenantId, assetId, body, parentId, ctx.userId ?? null]
  );
  const commentId = Number(ins.rows[0].id);
  await timeline(client, ctx, assetId, {
    eventType: 'COMMENT_ADDED', title: 'Comment added',
    description: body.length > 140 ? `${body.slice(0, 140)}...` : body,
    metadata: { commentId },
  });
  await logAudit(client, ctx, {
    action: 'comment', resource: 'assets.register', recordId: assetId, recordCode: asset.asset_no,
    newValues: { commentId },
  });
  return { commentId, assetId, body };
}
// ------------------------------------------------------------
// Asset register export (PDF / XLSX / CSV / JSON) with RBAC-scoped
// rows, branded rendering and a recorded export job.
// ------------------------------------------------------------
const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'json'];

export async function exportAssets(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const format = s(b.format) ? String(b.format).toLowerCase() : 'pdf';
  if (!EXPORT_FORMATS.includes(format)) throw badRequest(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
  const f = (b.filters ?? {}) as Record<string, unknown>;
  const where: string[] = ['a.tenant_id = $1', 'NOT a.is_deleted'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`a.company_id = $${params.length}`); }
  if (s(f.status)) { params.push(String(f.status).toUpperCase()); where.push(`a.status = $${params.length}`); }
  if (n(f.categoryId)) { params.push(n(f.categoryId)); where.push(`a.category_id = $${params.length}`); }
  if (n(f.locationId)) { params.push(n(f.locationId)); where.push(`a.location_id = $${params.length}`); }
  if (n(f.custodianId)) { params.push(n(f.custodianId)); where.push(`a.custodian_user_id = $${params.length}`); }
  if (n(f.branchId)) { params.push(n(f.branchId)); where.push(`a.branch_id = $${params.length}`); }
  if (n(f.departmentId)) { params.push(n(f.departmentId)); where.push(`a.department_id = $${params.length}`); }
  if (f.isMachine === '1' || f.isMachine === 'true') where.push('a.is_machine');
  if (s(f.search)) {
    params.push(`%${String(f.search).toLowerCase()}%`);
    where.push(`(lower(a.asset_no) LIKE $${params.length} OR lower(a.name) LIKE $${params.length} OR lower(COALESCE(a.serial_no,'')) LIKE $${params.length} OR lower(COALESCE(a.barcode,'')) LIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT a.id, a.asset_no, a.name, a.status, a.condition, a.is_machine,
            a.manufacturer, a.model, a.serial_no, a.purchase_cost, a.currency,
            a.purchase_date, a.useful_life_months, a.accumulated_depreciation,
            a.current_book_value, a.capitalization_date, a.eol_date,
            a.last_scan_at, a.last_verified_at, a.next_maintenance, a.next_inspection,
            COALESCE(ac.name, '') AS category, COALESCE(al.name, '') AS location,
            COALESCE(u.first_name || ' ' || u.last_name, '') AS custodian,
            COALESCE(d.name, '') AS department, COALESCE(b.name, '') AS branch,
            COALESCE(sup.name, '') AS supplier
     FROM asset_register a
     LEFT JOIN asset_categories ac ON ac.id = a.category_id
     LEFT JOIN asset_locations al ON al.id = a.location_id
     LEFT JOIN users u ON u.id = a.custodian_user_id
     LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN branches b ON b.id = a.branch_id
     LEFT JOIN suppliers sup ON sup.id = a.supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.asset_no`,
    params
  );
  const rows = res.rows;
  const columns: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center'; weight?: number }> = [
    { key: 'asset_no', label: 'Asset ID' },
    { key: 'name', label: 'Asset Name' },
    { key: 'category', label: 'Category' },
    { key: 'status', label: 'Status' },
    { key: 'condition', label: 'Condition' },
    { key: 'location', label: 'Location' },
    { key: 'custodian', label: 'Custodian' },
    { key: 'department', label: 'Department' },
    { key: 'purchase_cost', label: 'Cost', align: 'right' },
    { key: 'accumulated_depreciation', label: 'Acc. Depr.', align: 'right' },
    { key: 'current_book_value', label: 'Book Value', align: 'right' },
    { key: 'serial_no', label: 'Serial No' },
  ];
  const items = rows.map((r: Record<string, unknown>) => ({
    _no: '',
    asset_no: String(r.asset_no ?? ''),
    name: String(r.name ?? ''),
    category: String(r.category ?? ''),
    status: String(r.status ?? ''),
    condition: String(r.condition ?? ''),
    location: String(r.location ?? ''),
    custodian: String(r.custodian ?? ''),
    department: String(r.department ?? ''),
    purchase_cost: Number(r.purchase_cost ?? 0),
    accumulated_depreciation: Number(r.accumulated_depreciation ?? 0),
    current_book_value: Number(r.current_book_value ?? 0),
    serial_no: String(r.serial_no ?? ''),
  }));
  const totalCost = items.reduce((acc: number, i) => acc + Number(i.purchase_cost ?? 0), 0);
  const totalBook = items.reduce((acc: number, i) => acc + Number(i.current_book_value ?? 0), 0);
  const totalDep = items.reduce((acc: number, i) => acc + Number(i.accumulated_depreciation ?? 0), 0);
  const company = await loadCompanyProfile(client, ctx);
  const issuedAt = new Date().toISOString();
  const issuedBy = ctx.userId != null
    ? String((await client.query('SELECT first_name, last_name FROM users WHERE id = $1', [ctx.userId])).rows[0]?.first_name ?? '') + ' ' + String((await client.query('SELECT last_name FROM users WHERE id = $1', [ctx.userId])).rows[0]?.last_name ?? '')
    : 'System';
  const reportType = s(b.reportType) ?? 'Asset Register';
  const data = {
    code: `ASSET-REGISTER-${new Date().toISOString().slice(0, 10)}`,
    title: reportType,
    subtitle: `${rows.length} asset(s)`,
    currency: 'UGX',
    status: format === 'pdf' ? undefined : undefined,
    meta: [
      ['Company', String(company.name ?? '')],
      ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')],
      ['Generated By', issuedBy],
      ['Scope', ctx.branchId != null ? `Branch #${ctx.branchId}` : 'All branches'],
    ] as Array<[string, string]>,
    columns,
    items,
    totals: [
      ['Total Acquisition Cost', totalCost.toLocaleString('en-US', { maximumFractionDigits: 2 })],
      ['Accumulated Depreciation', totalDep.toLocaleString('en-US', { maximumFractionDigits: 2 })],
      ['Current Book Value', totalBook.toLocaleString('en-US', { maximumFractionDigits: 2 })],
    ] as Array<[string, string]>,
    notes: [`Generated from the ${company.name} Asset Register. Exports respect RBAC + ABAC scope.`],
    raw: rows,
  };
  const { buffer, contentType, extension } = await renderDocument(format, data as never, {
    company: company as never,
    issuedBy,
    issuedAt,
    correlationId: ctx.correlationId ?? null,
  });
  const jobNo = await nextNo(client, ctx, 'EXPORT');
  const jobRes = await client.query(
    `INSERT INTO asset_export_jobs (company_id, tenant_id, job_no, format, report_type, filters, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'COMPLETED',$7) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, jobNo, format.toUpperCase(), reportType,
      JSON.stringify({ ...f, rowCount: rows.length }), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'export', resource: 'assets.register', recordCode: jobNo,
    newValues: { format, reportType, rowCount: rows.length, jobId: Number(jobRes.rows[0].id) },
  });
  return { buffer, contentType, extension, jobId: Number(jobRes.rows[0].id), jobNo, rowCount: rows.length, format };
}

export async function listExportJobs(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`company_id = $${params.length}`); }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 100);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT * FROM asset_export_jobs WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(`SELECT count(*)::int AS total FROM asset_export_jobs WHERE ${where.join(' AND ')}`, params.slice(0, params.length - 2));
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}
export async function importAssets(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const file = fileFromBody(b);
  if (!file?.buffer && !Array.isArray(b.rows)) throw badRequest('Provide a file (CSV/XLSX/JSON) or a rows array');
  const fileName = String(file?.originalname ?? b.fileName ?? 'import.csv');
  const ext = (fileName.toLowerCase().split('.').pop() ?? 'csv');
  if (!['csv', 'xlsx', 'json'].includes(ext)) throw badRequest('Supported formats: CSV, XLSX, JSON');

  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(b.rows)) {
    rows = b.rows as Record<string, unknown>[];
  } else if (ext === 'csv') {
    const { parse } = await import('csv-parse/sync');
    const parsed = parse(file!.buffer!, {
      columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true,
    }) as Array<Record<string, string>>;
    rows = parsed;
  } else if (ext === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file!.buffer! as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('XLSX file has no worksheet');
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? '').trim(); });
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const rec: Record<string, unknown> = {};
      row.eachCell((cell, col) => { rec[headers[col - 1] ?? `col${col}`] = cell.value; });
      if (Object.values(rec).some((v) => v !== null && v !== undefined && String(v).trim() !== '')) rows.push(rec);
    });
  } else {
    const parsed: unknown = JSON.parse(file!.buffer!.toString('utf-8'));
    rows = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : Array.isArray((parsed as Record<string, unknown>).assets)
        ? ((parsed as Record<string, unknown>).assets as Array<Record<string, unknown>>)
        : [parsed as Record<string, unknown>];
  }
  if (rows.length === 0) throw badRequest('No rows found to import');
  if (rows.length > 5000) throw badRequest('Maximum 5000 rows per import');

  const jobNo = await nextNo(client, ctx, 'IMPORT');
  const jobRes = await client.query(
    `INSERT INTO asset_import_jobs (company_id, tenant_id, job_no, file_name, format, total_rows, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING',$7) RETURNING id`,
    [ctx.companyId, ctx.tenantId, jobNo, fileName, ext.toUpperCase(), rows.length, ctx.userId ?? null]
  );
  const jobId = Number(jobRes.rows[0].id);

  const pick = (r: Record<string, unknown>, keys: string[]): string | null => {
    for (const k of keys) {
      const direct = r[k];
      if (direct !== undefined && direct !== null && String(direct).trim() !== '') return String(direct).trim();
      const lk = Object.keys(r).find((kk) => kk.toLowerCase() === k.toLowerCase());
      if (lk) {
        const vv = r[lk];
        if (vv !== undefined && vv !== null && String(vv).trim() !== '') return String(vv).trim();
      }
    }
    return null;
  };
  const num = (r: Record<string, unknown>, keys: string[]): number | null => {
    const v = pick(r, keys);
    if (!v) return null;
    const x = Number(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(x) ? x : null;
  };
  const bool = (r: Record<string, unknown>, keys: string[]): boolean | null => {
    const v = pick(r, keys);
    if (!v) return null;
    return ['1', 'true', 'yes', 'y', 'machine', 'equipment'].includes(v.toLowerCase());
  };
  const byNameOrCode = async (table: string, value: string): Promise<number | null> => {
    if (!value) return null;
    const q = await client.query(
      `SELECT id FROM ${table} WHERE tenant_id = $1 AND (lower(name) = lower($2) OR lower(code) = lower($2))
       ORDER BY CASE WHEN lower(code) = lower($2) THEN 0 ELSE 1 END LIMIT 1`,
      [ctx.tenantId, value]
    );
    if (q.rows.length === 0) return null;
    return Number(q.rows[0].id);
  };

  const errors: Array<{ row: number; assetNo?: string; error: string }> = [];
  const assetIds: number[] = [];
  let successCount = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    try {
      const name = pick(r, ['name', 'asset_name', 'assetName', 'asset name']);
      if (!name) throw badRequest(`asset name is required`);
      const categoryValue = pick(r, ['category', 'category_code', 'categoryCode', 'asset_category']);
      const categoryId = categoryValue ? await byNameOrCode('asset_categories', categoryValue) : null;
      const locationValue = pick(r, ['location', 'location_code', 'locationCode', 'site']);
      const locationId = locationValue ? await byNameOrCode('asset_locations', locationValue) : null;
      const departmentValue = pick(r, ['department', 'department_code', 'departmentCode']);
      const departmentId = departmentValue ? await byNameOrCode('departments', departmentValue) : null;
      const supplierValue = pick(r, ['supplier', 'supplier_code', 'supplierCode']);
      const supplierId = supplierValue ? await byNameOrCode('suppliers', supplierValue) : null;
      const purchaseCost = num(r, ['purchase_cost', 'purchaseCost', 'cost', 'price']);
      const lifeYears = num(r, ['useful_life_years', 'usefulLifeYears']);
      const lifeMonths = num(r, ['useful_life_months', 'usefulLifeMonths']);
      const usefulLifeMonths = lifeMonths ?? (lifeYears != null ? Math.round(lifeYears * 12) : null);
      const isMachine = bool(r, ['is_machine', 'isMachine', 'machine']);
      const created = await createAsset(client, ctx, {
        name,
        categoryId,
        typeId: null,
        manufacturer: pick(r, ['manufacturer', 'make', 'brand']),
        model: pick(r, ['model']),
        serialNo: pick(r, ['serial_no', 'serialNo', 'serial', 'serial_number']),
        partNo: pick(r, ['part_no', 'partNo', 'part_number']),
        sku: pick(r, ['sku', 'sku_code']),
        barcode: pick(r, ['barcode']),
        description: pick(r, ['description', 'asset_description', 'notes']),
        locationId,
        departmentId,
        supplierId,
        purchaseCost,
        currency: pick(r, ['currency']) ?? 'UGX',
        purchaseDate: pick(r, ['purchase_date', 'purchaseDate', 'date_purchased']),
        usefulLifeMonths,
        residualValue: num(r, ['residual_value', 'residualValue']),
        isMachine: isMachine ?? undefined,
      });
      assetIds.push(Number(created.assetId));
      successCount += 1;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await client.query(
    `UPDATE asset_import_jobs SET status = 'COMPLETED', success_count = $1, error_count = $2, errors = $3, updated_at = now()
     WHERE id = $4`,
    [successCount, errors.length, JSON.stringify(errors.slice(0, 500)), jobId]
  );
  await logAudit(client, ctx, {
    action: 'import', resource: 'assets.register', recordCode: jobNo,
    newValues: { jobId, totalRows: rows.length, successCount, errorCount: errors.length },
  });
  return { jobId, jobNo, totalRows: rows.length, successCount, errorCount: errors.length, errors: errors.slice(0, 500), assetIds };
}

export async function listImportJobs(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (ctx.companyId != null) { params.push(ctx.companyId); where.push(`company_id = $${params.length}`); }
  const limit = Math.min(Math.max(n(q.pageSize) ?? 25, 1), 100);
  const page = Math.max(n(q.page) ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT id, job_no, file_name, format, total_rows, success_count, error_count, errors, status, created_by, created_at
     FROM asset_import_jobs WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(`SELECT count(*)::int AS total FROM asset_import_jobs WHERE ${where.join(' AND ')}`, params.slice(0, params.length - 2));
  return { rows: rows.rows, total: cnt.rows[0].total, page, pageSize: limit };
}
