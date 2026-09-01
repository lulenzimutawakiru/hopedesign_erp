import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, forbidden, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow } from './workflow.js';
import * as inventory from './inventory.js';
import * as assets from './assets.js';
import * as proc from './procurement.js';
import * as finance from './finance.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round2 = (v: number) => Math.round(v * 100) / 100;
const num0 = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoDate = (v: unknown): string => toISODate(v) ?? new Date().toISOString().slice(0, 10);

/** Resolve the authenticated user's linked employee record (nullable). */
async function requesterEmployeeId(client: pg.PoolClient, userId: number | null | undefined): Promise<number | null> {
  if (userId == null) return null;
  const res = await client.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  return res.rows.length ? n(res.rows[0].employee_id) : null;
}

const REQUEST_TYPES = [
  'MATERIAL', 'PURCHASE', 'ASSET', 'SERVICE', 'EXPENSE', 'PETTY_CASH',
  'PRODUCTION_MATERIAL', 'MAINTENANCE', 'EMERGENCY', 'PROJECT',
];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL'];
const ITEM_TYPES = ['INVENTORY_ITEM', 'ASSET', 'SERVICE', 'EXPENSE'];

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

/** Load the company the session is scoped to (all ops spend is company-scoped). */
function companyId(ctx: Ctx): number {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

async function departments(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM departments
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function costCentres(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM cost_centres
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function warehouses(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM warehouses
     WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function units(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM units WHERE tenant_id = $1 ORDER BY name LIMIT 500`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function projects(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM projects
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function expenseAccounts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM chart_of_accounts
     WHERE company_id = $1 AND tenant_id = $2 AND account_type = 'EXPENSE'
     ORDER BY code LIMIT 300`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

/** Form metadata: departments, cost centres, units, warehouses, projects, expense accounts. */
export async function requisitionMeta(client: pg.PoolClient, ctx: Ctx) {
  const [depts, centres, unitsRows, stores, projs, accounts] = await Promise.all([
    departments(client, ctx),
    costCentres(client, ctx),
    units(client, ctx),
    warehouses(client, ctx),
    projects(client, ctx),
    expenseAccounts(client, ctx),
  ]);
  return { departments: depts, costCentres: centres, units: unitsRows, warehouses: stores, projects: projs, expenseAccounts: accounts };
}

/**
 * Smart item search: product code/name match plus live stock position so the
 * request form can show Available / Reserved / Available-to-Issue instantly and
 * recommend STORE_ISSUE vs PURCHASE before the requisition is even created.
 */
export async function smartItemLookup(client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>) {
  const q = String(query.q ?? '').trim();
  const company = companyId(ctx);
  const params: unknown[] = [company, ctx.tenantId];
  let where = `p.company_id = $1 AND p.tenant_id = $2 AND p.status = 'ACTIVE'`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`;
  }
  const res = await client.query(
    `SELECT p.id, p.code, p.name, p.type, p.reorder_point,
            COALESCE((SELECT SUM(i.quantity)::numeric FROM inventory i
               WHERE i.product_id = p.id AND i.company_id = p.company_id AND i.tenant_id = p.tenant_id), 0) AS on_hand,
            COALESCE((SELECT SUM(i.reserved_qty)::numeric FROM inventory i
               WHERE i.product_id = p.id AND i.company_id = p.company_id AND i.tenant_id = p.tenant_id), 0) AS reserved,
            COALESCE((SELECT SUM(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty)::numeric FROM inventory i
               WHERE i.product_id = p.id AND i.company_id = p.company_id AND i.tenant_id = p.tenant_id), 0) AS available
     FROM products p
     WHERE ${where}
     ORDER BY p.code
     LIMIT 25`,
    params
  );
  return toCamelRows(res.rows).map((r) => {
    const onHand = num0(r.onHand);
    const reserved = num0(r.reserved);
    const available = num0(r.available);
    const reorder = num0(r.reorderPoint);
    const reorderStatus = available <= 0 ? 'OUT_OF_STOCK' : available <= reorder ? 'LOW' : 'HEALTHY';
    return {
      ...r,
      onHandQty: onHand,
      reservedQty: reserved,
      availableToIssue: available,
      reorderStatus,
      recommendation: available > 0 ? 'STORE_ISSUE' : 'PURCHASE',
    };
  });
}

/**
 * Budget control: annual budget vs used/committed/available plus the impact of
 * the new request. Over-budget behaviour is configurable through app_settings
 * (category 'expenditure', key 'allow_over_budget').
 */
export async function budgetControl(client: pg.PoolClient, ctx: Ctx, accountId: number | null | undefined, amount: number) {
  const company = companyId(ctx);
  if (!accountId) {
    return { accountId: null, approved: 0, committed: 0, actual: 0, available: 0, requestAmount: amount, remaining: amount, withinBudget: true, overBudget: false, budgetId: null, budgetNo: null };
  }
  const pos = await finance.budgetPosition(client, ctx, accountId);
  const approved = num0(pos.approved);
  const committed = num0(pos.committed);
  const actual = num0(pos.actual);
  const used = committed + actual;
  const available = Math.max(0, approved - used);
  const remaining = available - amount;
  const overBudget = remaining < 0;
  let allow = false;
  try {
    const setting = await client.query(
      `SELECT value FROM app_settings WHERE company_id = $1 AND tenant_id = $2 AND category = 'expenditure' AND key = 'allow_over_budget' LIMIT 1`,
      [company, ctx.tenantId]
    );
    allow = setting.rows.length ? setting.rows[0].value === true || String(setting.rows[0].value) === 'true' : false;
  } catch {
    allow = false;
  }
  return {
    accountId,
    approved,
    committed,
    actual,
    used,
    available,
    requestAmount: amount,
    remaining,
    withinBudget: !overBudget || allow,
    overBudget,
    allowOverBudget: allow,
    budgetId: pos.budgetId != null ? Number(pos.budgetId) : null,
    budgetNo: pos.budgetNo != null ? String(pos.budgetNo) : null,
  };
}

function riskLevelFor(score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (score >= 60) return 'CRITICAL';
  if (score >= 40) return 'HIGH';
  if (score >= 20) return 'MEDIUM';
  return 'LOW';
}

/** Approval risk engine: flags unusual requests and returns a risk score/level. */
async function riskEngine(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>, total: number, isEmergency: boolean) {
  const flags: string[] = [];
  let score = 0;
  if (isEmergency) {
    flags.push('EMERGENCY_REQUEST');
    score += 20;
  }
  if (total > 20_000_000) {
    flags.push('HIGH_VALUE');
    score += 20;
  } else if (total > 5_000_000) {
    flags.push('ELEVATED_VALUE');
    score += 10;
  }
  const priority = String(b.priority ?? 'NORMAL').toUpperCase();
  if (priority === 'CRITICAL' || priority === 'URGENT') {
    flags.push('HIGH_PRIORITY');
    score += 10;
  }
  if (!String(b.purpose ?? '').trim()) {
    flags.push('NO_PURPOSE');
    score += 5;
  }
  const requiredDate = isoDate(b.requiredDate);
  if (requiredDate) {
    const day = new Date(`${requiredDate}T00:00:00`).getDay();
    if (day === 0 || day === 6) {
      flags.push('WEEKEND_REQUEST');
      score += 10;
    }
  }
  if (isEmergency) {
    const deptId = n(b.departmentId);
    const recent = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM requisitions
       WHERE company_id = $1 AND tenant_id = $2 AND department_id = $3
         AND is_emergency = true AND created_at >= now() - interval '14 days'`,
      [companyId(ctx), ctx.tenantId, deptId]
    );
    if (Number(recent.rows[0].cnt) >= 3) {
      flags.push('REPEATED_EMERGENCY');
      score += 15;
    }
  }
  return { riskScore: score, riskLevel: riskLevelFor(score), riskFlags: flags };
}

/** Look up the live stock snapshot for a product so the decision engine can recommend STORE_ISSUE vs PURCHASE. */
async function stockSnapshot(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const res = await client.query(
    `SELECT
       COALESCE(SUM(i.quantity),0)::numeric AS on_hand,
       COALESCE(SUM(i.reserved_qty),0)::numeric AS reserved,
       COALESCE(SUM(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty),0)::numeric AS available,
       COALESCE(MAX(p.reorder_point),0)::numeric AS reorder_point
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     WHERE i.product_id = $1 AND i.company_id = $2 AND i.tenant_id = $3`,
    [productId, companyId(ctx), ctx.tenantId]
  );
  const row = res.rows[0];
  const onHand = num0(row.on_hand);
  const reserved = num0(row.reserved);
  const available = num0(row.available);
  const reorder = num0(row.reorder_point);
  return {
    onHand,
    reserved,
    available,
    reorderStatus: available <= 0 ? 'OUT_OF_STOCK' : available <= reorder ? 'LOW' : 'HEALTHY',
  };
}

/** Check whether an existing, assignable asset matches the requested category/name. */
async function findAssignableAsset(client: pg.PoolClient, ctx: Ctx, category: string | null, description: string) {
  if (!category) return null;
  const res = await client.query(
    `SELECT a.id, a.asset_no, a.name
     FROM asset_register a
     WHERE a.company_id = $1 AND a.tenant_id = $2
       AND a.status IN ('AVAILABLE','IN_STORE','REGISTERED')
       AND a.custody_status IS DISTINCT FROM 'ASSIGNED'
       AND (a.category_id IS NOT NULL OR a.name ILIKE '%' || $4 || '%')
       AND (a.name ILIKE '%' || $3 || '%' OR a.asset_no ILIKE '%' || $3 || '%')
     ORDER BY a.id LIMIT 1`,
    [companyId(ctx), ctx.tenantId, category, description]
  );
  return res.rows.length ? { assetId: Number(res.rows[0].id), assetNo: String(res.rows[0].asset_no), name: String(res.rows[0].name) } : null;
}

interface LineInput {
  itemType?: string;
  productId?: number | null;
  assetCategory?: string | null;
  description?: string;
  quantity?: number;
  unitId?: number | null;
  unitCode?: string | null;
  unitCost?: number;
  accountId?: number | null;
  expenseCategoryId?: number | null;
  warehouseId?: number | null;
}

/** Decision engine: resolve each line to a fulfillment recommendation with live stock snapshots. */
async function decideLine(client: pg.PoolClient, ctx: Ctx, line: LineInput) {
  const itemType = String(line.itemType ?? 'INVENTORY_ITEM').toUpperCase();
  if (!ITEM_TYPES.includes(itemType)) throw badRequest(`Unsupported item type ${itemType}`);
  const description = String(line.description ?? '').trim();
  if (!description) throw badRequest('Each line needs a description');
  const quantity = Math.max(0, num0(line.quantity) || 1);
  const unitCost = Math.max(0, num0(line.unitCost));
  const amount = round2(quantity * unitCost);
  if (itemType === 'INVENTORY_ITEM') {
    if (!line.productId) throw badRequest('Inventory item lines require a product');
    const snap = await stockSnapshot(client, ctx, line.productId);
    const recommendation = snap.available > 0 ? 'STORE_ISSUE' : 'PURCHASE';
    return {
      itemType, productId: n(line.productId), assetCategory: null, description,
      quantity, unitId: n(line.unitId), unitCode: s(line.unitCode), unitCost, amount,
      accountId: n(line.accountId), expenseCategoryId: n(line.expenseCategoryId), warehouseId: n(line.warehouseId),
      stockOnHand: snap.onHand, reservedQty: snap.reserved, availableToIssue: snap.available,
      reorderStatus: snap.reorderStatus, recommendation,
    };
  }
  if (itemType === 'ASSET') {
    const existing = await findAssignableAsset(client, ctx, s(line.assetCategory), description);
    return {
      itemType, productId: null, assetCategory: s(line.assetCategory), description,
      quantity: 1, unitId: null, unitCode: null, unitCost, amount,
      accountId: n(line.accountId), expenseCategoryId: null, warehouseId: null,
      stockOnHand: 0, reservedQty: 0, availableToIssue: 0, reorderStatus: null,
      recommendation: existing ? 'ASSET_ASSIGN' : 'ASSET_PURCHASE',
      matchAssetId: existing?.assetId ?? null, matchAssetNo: existing?.assetNo ?? null,
    };
  }
  return {
    itemType, productId: null, assetCategory: null, description,
    quantity, unitId: n(line.unitId), unitCode: s(line.unitCode), unitCost, amount,
    accountId: n(line.accountId), expenseCategoryId: n(line.expenseCategoryId), warehouseId: null,
    stockOnHand: 0, reservedQty: 0, availableToIssue: 0, reorderStatus: null,
    recommendation: 'PAYMENT',
  };
}

function fulfillmentMethodFor(recommendations: string[]): string | null {
  const unique = [...new Set(recommendations)];
  if (unique.length === 1) return unique[0];
  return 'MIXED';
}

/** Create a requisition (draft). Runs the decision + risk engines, stores line snapshots. */
export async function createRequisition(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const company = companyId(ctx);
  const requestType = String(b.requestType ?? 'MATERIAL').toUpperCase();
  if (!REQUEST_TYPES.includes(requestType)) throw badRequest(`Unsupported request type ${requestType}`);
  const priority = String(b.priority ?? 'NORMAL').toUpperCase();
  if (!PRIORITIES.includes(priority)) throw badRequest(`Unsupported priority ${priority}`);
  const departmentId = n(b.departmentId);
  if (!departmentId) throw badRequest('Requesting department is required');
  const linesIn: LineInput[] = Array.isArray(b.items) ? b.items : [];
  if (!linesIn.length) throw badRequest('Add at least one line');
  const decided: Awaited<ReturnType<typeof decideLine>>[] = [];
  for (const line of linesIn) decided.push(await decideLine(client, ctx, line));
  const total = round2(decided.reduce((sum, l) => sum + l.amount, 0));
  const isEmergency = requestType === 'EMERGENCY' || b.isEmergency === true;
  const risk = await riskEngine(client, ctx, b, total, isEmergency);
  const reqNo = await nextDoc(client, ctx, 'REQ');
  const employeeId = n(b.employeeId) ?? (await requesterEmployeeId(client, ctx.userId));
  const req = await client.query(
    `INSERT INTO requisitions
       (company_id, tenant_id, branch_id, req_no, request_type, department_id, requested_by, employee_id,
        required_date, priority, purpose, cost_centre_id, project_id, budget_id, account_id, warehouse_id,
        estimated_total, currency, fulfillment_method, is_emergency, risk_score, risk_level, status, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'DRAFT',$23,$24)
     RETURNING id`,
    [
      company, ctx.tenantId, ctx.branchId ?? null, reqNo, requestType, departmentId, ctx.userId ?? 0, employeeId,
      isoDate(b.requiredDate), priority, s(b.purpose), n(b.costCentreId), n(b.projectId), n(b.budgetId), n(b.accountId), n(b.warehouseId),
      total, String(b.currency ?? 'UGX').toUpperCase(), fulfillmentMethodFor(decided.map((l) => l.recommendation)),
      isEmergency, risk.riskScore, risk.riskLevel, ctx.userId ?? null, ctx.userId ?? null,
    ]
  );
  const requisitionId = Number(req.rows[0].id);
  let lineNo = 1;
  for (const l of decided) {
    await client.query(
      `INSERT INTO requisition_lines
         (requisition_id, tenant_id, line_no, item_type, product_id, asset_category, description, quantity,
          unit_id, unit_code, unit_cost, amount, account_id, expense_category_id, warehouse_id,
          stock_on_hand, reserved_qty, available_to_issue, reorder_status, recommendation, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'OPEN')`,
      [
        requisitionId, ctx.tenantId, lineNo++, l.itemType, l.productId, l.assetCategory, l.description, l.quantity,
        l.unitId, l.unitCode, l.unitCost, l.amount, l.accountId, l.expenseCategoryId, l.warehouseId,
        l.stockOnHand, l.reservedQty, l.availableToIssue, l.reorderStatus, l.recommendation,
      ]
    );
  }
  await logAudit(client, ctx, { action: 'create', resource: 'requisitions', recordId: requisitionId, recordCode: reqNo, newValues: { requestType, total } });
  await emitEvent(client, ctx, { eventType: 'requisition.created', entityType: 'ops.requisitions', entityId: requisitionId, entityCode: reqNo, payload: { requestType, total, riskLevel: risk.riskLevel } });
  const header = await getRequisition(client, ctx, requisitionId);
  return { ...header, risk: risk.riskFlags, budget: await budgetControl(client, ctx, b.accountId != null ? n(b.accountId) : null, total) };
}

/** Update a draft requisition: replaces the line set and re-runs the decision engine. */
export async function updateRequisition(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const existing = await getRequisition(client, ctx, id);
  if (existing.status !== 'DRAFT') throw badRequest('Only draft requisitions can be edited');
  const linesIn: LineInput[] = Array.isArray(b.items) ? b.items : [];
  if (!linesIn.length) throw badRequest('Add at least one line');
  const decided: Awaited<ReturnType<typeof decideLine>>[] = [];
  for (const line of linesIn) decided.push(await decideLine(client, ctx, line));
  const total = round2(decided.reduce((sum, l) => sum + l.amount, 0));
  const priority = b.priority != null ? String(b.priority).toUpperCase() : existing.priority;
  const isEmergency = String(b.requestType ?? existing.requestType).toUpperCase() === 'EMERGENCY' || b.isEmergency === true;
  const risk = await riskEngine(client, ctx, { ...b, priority, requiredDate: b.requiredDate ?? existing.requiredDate }, total, isEmergency);
  await client.query(
    `UPDATE requisitions SET request_type = $1, department_id = $2, required_date = $3, priority = $4, purpose = $5,
       cost_centre_id = $6, project_id = $7, budget_id = $8, account_id = $9, warehouse_id = $10,
       estimated_total = $11, currency = $12, fulfillment_method = $13, is_emergency = $14,
       risk_score = $15, risk_level = $16, updated_by = $17 WHERE id = $18`,
    [
      String(b.requestType ?? existing.requestType).toUpperCase(), n(b.departmentId) ?? existing.departmentId,
      isoDate(b.requiredDate ?? existing.requiredDate), priority, s(b.purpose) ?? existing.purpose,
      n(b.costCentreId) ?? existing.costCentreId, n(b.projectId) ?? existing.projectId,
      n(b.budgetId) ?? existing.budgetId, n(b.accountId) ?? existing.accountId, n(b.warehouseId) ?? existing.warehouseId,
      total, String(b.currency ?? existing.currency ?? 'UGX').toUpperCase(), fulfillmentMethodFor(decided.map((l) => l.recommendation)),
      isEmergency, risk.riskScore, risk.riskLevel, ctx.userId ?? null, id,
    ]
  );
  await client.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [id]);
  let lineNo = 1;
  for (const l of decided) {
    await client.query(
      `INSERT INTO requisition_lines
         (requisition_id, tenant_id, line_no, item_type, product_id, asset_category, description, quantity,
          unit_id, unit_code, unit_cost, amount, account_id, expense_category_id, warehouse_id,
          stock_on_hand, reserved_qty, available_to_issue, reorder_status, recommendation, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'OPEN')`,
      [
        id, ctx.tenantId, lineNo++, l.itemType, l.productId, l.assetCategory, l.description, l.quantity,
        l.unitId, l.unitCode, l.unitCost, l.amount, l.accountId, l.expenseCategoryId, l.warehouseId,
        l.stockOnHand, l.reservedQty, l.availableToIssue, l.reorderStatus, l.recommendation,
      ]
    );
  }
  await logAudit(client, ctx, { action: 'update', resource: 'requisitions', recordId: id, recordCode: String(existing.reqNo), newValues: { total } });
  return getRequisition(client, ctx, id);
}

/** Snapshot the active approval tasks into requisition_approvals for a permanent audit trail. */
async function snapshotApprovals(client: pg.PoolClient, ctx: Ctx, requisitionId: number, instanceId: number) {
  const res = await client.query(
    `SELECT t.step_seq, t.step_name, t.approver_role_id, t.approver_user_id, t.status,
            r.code AS role_code
     FROM approval_tasks t
     LEFT JOIN roles r ON r.id = t.approver_role_id
     WHERE t.instance_id = $1
     ORDER BY t.step_seq, t.id`,
    [instanceId]
  );
  let isCurrentSet = false;
  for (const row of res.rows) {
    const isCurrent = !isCurrentSet && row.status === 'PENDING';
    if (isCurrent) isCurrentSet = true;
    await client.query(
      `INSERT INTO requisition_approvals
         (requisition_id, tenant_id, step_seq, step_name, approver_role, approver_user_id, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [requisitionId, ctx.tenantId, Number(row.step_seq), String(row.step_name), row.role_code != null ? String(row.role_code) : null, row.approver_user_id != null ? Number(row.approver_user_id) : null, isCurrent]
    );
  }
}

/** Submit a draft requisition: budget gate, workflow start, approval snapshot, notifications. */
export async function submitRequisition(client: pg.PoolClient, ctx: Ctx, id: number) {
  const req = await getRequisition(client, ctx, id);
  if (req.status !== 'DRAFT') throw badRequest(`Only draft requisitions can be submitted (current: ${req.status})`);
  const total = num0(req.estimatedTotal);
  const budget = await budgetControl(client, ctx, req.accountId != null ? Number(req.accountId) : null, total);
  if (budget.overBudget && !budget.allowOverBudget) {
    throw badRequest(
      `This request exceeds the available budget (available ${budget.available.toLocaleString()}, requested ${total.toLocaleString()}). ` +
      `Raise the allowance in Settings > Expenditure (allow_over_budget) or reduce the amount.`,
      budget
    );
  }
  await client.query(
    `UPDATE requisitions SET status = 'SUBMITTED', submitted_at = now(), updated_by = $1 WHERE id = $2`,
    [ctx.userId ?? null, id]
  );
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.requisitions',
    entityId: id,
    entityCode: String(req.reqNo),
    amount: total,
    companyId: req.companyId != null ? Number(req.companyId) : ctx.companyId ?? null,
    branchId: req.branchId != null ? Number(req.branchId) : ctx.branchId ?? null,
  });
  if (instanceId) await snapshotApprovals(client, ctx, id, instanceId);
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.requisitions',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(req.reqNo), ctx.userId ?? null, JSON.stringify({ amount: total, budget }) ]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'requisitions', recordId: id, recordCode: String(req.reqNo), newValues: { status: 'SUBMITTED', budget } });
  await emitEvent(client, ctx, { eventType: 'requisition.submitted', entityType: 'ops.requisitions', entityId: id, entityCode: String(req.reqNo), payload: { amount: total, budget } });
  return getRequisition(client, ctx, id);
}

/** Cancel a requisition that has not been fulfilled. */
export async function cancelRequisition(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const req = await getRequisition(client, ctx, id);
  if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(String(req.status))) {
    throw badRequest(`Requisition ${req.reqNo} cannot be cancelled from status ${req.status}`);
  }
  await client.query(
    `UPDATE requisitions SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $1, updated_by = $2 WHERE id = $3`,
    [reason ?? null, ctx.userId ?? null, id]
  );
  await client.query(
    `UPDATE requisition_lines SET status = 'CANCELLED' WHERE requisition_id = $1 AND status = 'OPEN'`,
    [id]
  );
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, comment)
     VALUES ($1,$2,'ops.requisitions',$3,$4,'VOID',$5,$6)`,
    [companyId(ctx), ctx.tenantId, id, String(req.reqNo), ctx.userId ?? null, reason ?? null]
  );
  await logAudit(client, ctx, { action: 'cancel', resource: 'requisitions', recordId: id, recordCode: String(req.reqNo), newValues: { status: 'CANCELLED', reason } });
  await emitEvent(client, ctx, { eventType: 'requisition.cancelled', entityType: 'ops.requisitions', entityId: id, entityCode: String(req.reqNo), payload: { reason } });
  return getRequisition(client, ctx, id);
}

/** Refresh live stock availability for every inventory line on a requisition. */
export async function requisitionInventoryCheck(client: pg.PoolClient, ctx: Ctx, id: number) {
  const lines = await client.query(
    `SELECT id, product_id, description, quantity, available_to_issue
     FROM requisition_lines WHERE requisition_id = $1 AND item_type = 'INVENTORY_ITEM' AND product_id IS NOT NULL`,
    [id]
  );
  const checks: Array<Record<string, unknown>> = [];
  for (const line of lines.rows) {
    const snap = await stockSnapshot(client, ctx, Number(line.product_id));
    checks.push({
      lineId: Number(line.id),
      productId: Number(line.product_id),
      description: String(line.description),
      requestedQty: num0(line.quantity),
      requestedAtRequestTime: num0(line.available_to_issue),
      ...snap,
      sufficient: snap.available >= num0(line.quantity),
    });
  }
  return checks;
}

/** Resolve a default location for asset assignment (company default first). */
async function defaultLocation(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id FROM locations WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [companyId(ctx), ctx.tenantId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

/** Fulfil an approved requisition: reserve+issue stock, raise PRs, assign assets, create expense records. */
export async function fulfillRequisition(client: pg.PoolClient, ctx: Ctx, id: number) {
  const req = await getRequisition(client, ctx, id);
  if (!['APPROVED', 'PARTIALLY_FULFILLED'].includes(String(req.status))) {
    throw badRequest(`Only approved requisitions can be fulfilled (current: ${req.status})`);
  }
  const company = companyId(ctx);
  const reqId = Number(req.id);
  const reqNo = String(req.reqNo);
  const departmentId = req.departmentId != null ? Number(req.departmentId) : null;
  const costCentreId = req.costCentreId != null ? Number(req.costCentreId) : null;
  const projectId = req.projectId != null ? Number(req.projectId) : null;
  const headerAccountId = req.accountId != null ? Number(req.accountId) : null;
  const lines = await client.query(
    `SELECT * FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no`,
    [id]
  );
  const locationId = await defaultLocation(client, ctx);
  let completed = 0;
  for (const line of lines.rows) {
    const lineId = Number(line.id);
    if (!['OPEN', 'RESERVED'].includes(String(line.status))) continue;
    const recommendation = String(line.recommendation);
    const productId = line.product_id != null ? Number(line.product_id) : null;
    const quantity = num0(line.quantity);
    const unitCost = num0(line.unit_cost);
    const warehouseId = line.warehouse_id != null ? Number(line.warehouse_id) : req.warehouseId != null ? Number(req.warehouseId) : null;
    if (recommendation === 'STORE_ISSUE' && productId) {
      const reservationId = await inventory.reserve(client, ctx, {
        product: productId, warehouse: warehouseId, qty: quantity,
        refType: 'requisition', refId: reqId,
      });
      await client.query(`UPDATE requisition_lines SET status = 'RESERVED' WHERE id = $1`, [lineId]);
      const movementId = await inventory.postMove(client, ctx, {
        movementType: 'ISSUE',
        product: productId,
        warehouse: warehouseId,
        quantity,
        unitCost,
        refType: 'requisition',
        refId: reqId,
        refCode: reqNo,
        reason: `Store issue for requisition ${reqNo}`,
      });
      await inventory.consume(client, reservationId);
      await client.query(
        `INSERT INTO requisition_fulfillments
           (company_id, tenant_id, requisition_id, line_id, fulfillment_type, ref_type, ref_id, quantity, amount, status, fulfilled_by, fulfilled_at, metadata)
         VALUES ($1,$2,$3,$4,'STORE_ISSUE','inventory_movement',$5,$6,$7,'COMPLETED',$8,now(),$9::jsonb)`,
        [company, ctx.tenantId, reqId, lineId, movementId, quantity, round2(quantity * unitCost), ctx.userId ?? null, JSON.stringify({ reservationId, warehouseId })]
      );
      await client.query(`UPDATE requisition_lines SET status = 'ISSUED' WHERE id = $1`, [lineId]);
      completed += 1;
    } else if (recommendation === 'PURCHASE' || recommendation === 'ASSET_PURCHASE') {
      const itemType = String(line.item_type);
      if (productId == null) {
        // No product SKU (e.g. asset purchase without a catalogued product):
        // record the procurement intent; the actual purchase completes in Assets/Procurement.
        await client.query(
          `INSERT INTO requisition_fulfillments
             (company_id, tenant_id, requisition_id, line_id, fulfillment_type, ref_type, ref_id, ref_code, quantity, amount, status, fulfilled_by, fulfilled_at, metadata)
           VALUES ($1,$2,$3,$4,'ASSET_PURCHASE','assets.register',NULL,NULL,$5,$6,'PENDING',$7,now(),$8::jsonb)`,
          [company, ctx.tenantId, reqId, lineId, quantity, round2(quantity * unitCost), ctx.userId ?? null,
           JSON.stringify({ note: 'Asset purchase queued; create the asset via Assets after purchase' })]
        );
        await client.query(`UPDATE requisition_lines SET status = 'PURCHASED' WHERE id = $1`, [lineId]);
        completed += 1;
        continue;
      }
      const pr = await proc.createRequisition(client, ctx, {
        title: `From requisition ${reqNo}`,
        notes: String(line.description ?? req.purpose ?? ''),
        departmentId,
        requiredDate: req.requiredDate != null ? String(req.requiredDate).slice(0, 10) : null,
        costCentreId,
        accountId: line.account_id != null ? Number(line.account_id) : headerAccountId,
        warehouseId,
        items: [
          {
            productId,
            description: String(line.description),
            quantity,
            estimatedCost: unitCost,
            needBy: req.requiredDate != null ? String(req.requiredDate).slice(0, 10) : null,
          },
        ],
      });
      await client.query(
        `INSERT INTO requisition_fulfillments
           (company_id, tenant_id, requisition_id, line_id, fulfillment_type, ref_type, ref_id, ref_code, quantity, amount, status, fulfilled_by, fulfilled_at, metadata)
         VALUES ($1,$2,$3,$4,'PURCHASE_REQUISITION','procurement.requisitions',$5,$6,$7,$8,'PENDING',$9,now(),$10::jsonb)`,
        [company, ctx.tenantId, reqId, lineId, pr.requisitionId, pr.prNo, quantity, round2(quantity * unitCost), ctx.userId ?? null, JSON.stringify({ note: 'Handed off to procurement' })]
      );
      await client.query(`UPDATE requisition_lines SET status = 'PURCHASED' WHERE id = $1`, [lineId]);
      completed += 1;
    } else if (recommendation === 'ASSET_ASSIGN') {
      const match = await findAssignableAsset(client, ctx, line.asset_category != null ? String(line.asset_category) : null, String(line.description));
      if (!match || !locationId) {
        throw badRequest(`No assignable asset found for line ${line.description} (or no location configured); request a purchase instead`);
      }
      await assets.assignAsset(client, ctx, match.assetId, {
        custodianDepartmentId: departmentId,
        locationId,
        reason: `Assigned from requisition ${reqNo}`,
      });
      await client.query(
        `INSERT INTO requisition_fulfillments
           (company_id, tenant_id, requisition_id, line_id, fulfillment_type, ref_type, ref_id, ref_code, quantity, amount, status, fulfilled_by, fulfilled_at, metadata)
         VALUES ($1,$2,$3,$4,'ASSET_ASSIGNMENT','assets.register',$5,$6,$7,1,0,'COMPLETED',$8,now(),$9::jsonb)`,
        [company, ctx.tenantId, reqId, lineId, match.assetId, match.assetNo, ctx.userId ?? null, JSON.stringify({ name: match.name })]
      );
      await client.query(`UPDATE requisition_lines SET status = 'ASSIGNED' WHERE id = $1`, [lineId]);
      completed += 1;
    } else if (recommendation === 'PAYMENT') {
      const expNo = await nextDoc(client, ctx, 'EXP');
      const categoryId = line.expense_category_id != null ? Number(line.expense_category_id) : null;
      const exp = await client.query(
        `INSERT INTO expense_transactions
           (company_id, tenant_id, branch_id, exp_no, exp_date, department_id, cost_centre_id, category_id,
            description, amount, currency, payee, project_id, account_id, is_planned, requisition_id,
            status, payment_status, accounting_status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,'DRAFT','UNPAID','UNPOSTED',$15,$15)
         RETURNING id`,
        [company, ctx.tenantId, ctx.branchId ?? null, expNo, departmentId, costCentreId, categoryId,
         String(line.description), round2(quantity * unitCost), String(req.currency ?? 'UGX'),
         s(String(line.description)), projectId, line.account_id != null ? Number(line.account_id) : headerAccountId, reqId, ctx.userId ?? null]
      );
      await client.query(
        `INSERT INTO requisition_fulfillments
           (company_id, tenant_id, requisition_id, line_id, fulfillment_type, ref_type, ref_id, ref_code, quantity, amount, status, fulfilled_by, fulfilled_at, metadata)
         VALUES ($1,$2,$3,$4,'EXPENSE','expense_transactions',$5,$6,$7,$8,'PENDING',$9,now(),$10::jsonb)`,
        [company, ctx.tenantId, reqId, lineId, Number(exp.rows[0].id), expNo, quantity, round2(quantity * unitCost), ctx.userId ?? null, JSON.stringify({ note: 'Expense record created from requisition; complete payment in Daily Expenditure' })]
      );
      await client.query(`UPDATE requisition_lines SET status = 'ISSUED' WHERE id = $1`, [lineId]);
      completed += 1;
    }
  }
  const remaining = lines.rows.length - completed;
  const finalStatus = remaining > 0 ? 'PARTIALLY_FULFILLED' : 'FULFILLED';
  await client.query(
    `UPDATE requisitions SET status = $1, fulfilled_at = CASE WHEN $2 THEN now() ELSE fulfilled_at END, updated_by = $3 WHERE id = $4`,
    [finalStatus, remaining === 0, ctx.userId ?? null, id]
  );
  await logAudit(client, ctx, { action: 'fulfill', resource: 'requisitions', recordId: id, recordCode: reqNo, newValues: { status: finalStatus, linesCompleted: completed, linesRemaining: remaining } });
  await emitEvent(client, ctx, { eventType: 'requisition.fulfilled', entityType: 'ops.requisitions', entityId: id, entityCode: reqNo, payload: { status: finalStatus, completed } });
  return getRequisition(client, ctx, id);
}

const REQUISITION_SELECT = `
  SELECT r.*, d.code AS department_code, d.name AS department_name,
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

export async function getRequisition(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(`${REQUISITION_SELECT} WHERE r.id = $1 AND r.tenant_id = $2 AND r.company_id = $3`, [
    id, ctx.tenantId, companyId(ctx),
  ]);
  if (!res.rows.length) throw notFound('Requisition not found');
  const header = toCamelRow(res.rows[0]);
  const lines = await client.query(
    `SELECT l.*, p.code AS product_code, p.name AS product_name
     FROM requisition_lines l
     LEFT JOIN products p ON p.id = l.product_id
     WHERE l.requisition_id = $1 ORDER BY l.line_no`,
    [id]
  );
  const approvals = await client.query(
    `SELECT ra.*, u.first_name || ' ' || u.last_name AS decider_name
     FROM requisition_approvals ra
     LEFT JOIN users u ON u.id = ra.decided_by
     WHERE ra.requisition_id = $1 ORDER BY ra.step_seq, ra.id`,
    [id]
  );
  const fulfillments = await client.query(
    `SELECT rf.*, u.first_name || ' ' || u.last_name AS fulfilled_by_name
     FROM requisition_fulfillments rf
     LEFT JOIN users u ON u.id = rf.fulfilled_by
     WHERE rf.requisition_id = $1 ORDER BY rf.id`,
    [id]
  );
  return { ...header, lines: toCamelRows(lines.rows), approvals: toCamelRows(approvals.rows), fulfillments: toCamelRows(fulfillments.rows) };
}

export async function listRequisitions(client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>) {
  const params: unknown[] = [companyId(ctx), ctx.tenantId];
  const where: string[] = ['r.company_id = $1', 'r.tenant_id = $2'];
  if (query.status != null && String(query.status)) {
    params.push(String(query.status).toUpperCase());
    where.push(`r.status = $${params.length}`);
  }
  if (query.requestType != null && String(query.requestType)) {
    params.push(String(query.requestType).toUpperCase());
    where.push(`r.request_type = $${params.length}`);
  }
  if (query.departmentId != null && String(query.departmentId)) {
    params.push(Number(query.departmentId));
    where.push(`r.department_id = $${params.length}`);
  }
  if (query.requestedBy != null && String(query.requestedBy)) {
    params.push(Number(query.requestedBy));
    where.push(`r.requested_by = $${params.length}`);
  }
  if (query.q != null && String(query.q)) {
    params.push(`%${String(query.q)}%`);
    where.push(`(r.req_no ILIKE $${params.length} OR r.purpose ILIKE $${params.length})`);
  }
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25) || 25));
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `${REQUISITION_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await client.query(
    `SELECT COUNT(*)::int AS total FROM requisitions r WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { items: toCamelRows(res.rows), total: Number(count.rows[0].total), page, pageSize };
}

/** Approval center + requisition command board grouped by status/type. */
export async function requisitionBoard(client: pg.PoolClient, ctx: Ctx) {
  const company = companyId(ctx);
  const pending = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE request_type = 'MATERIAL')::int AS material,
            COUNT(*) FILTER (WHERE request_type = 'PURCHASE')::int AS purchase,
            COUNT(*) FILTER (WHERE request_type = 'ASSET')::int AS asset,
            COUNT(*) FILTER (WHERE request_type = 'SERVICE')::int AS service,
            COUNT(*) FILTER (WHERE request_type = 'EXPENSE')::int AS expense,
            COUNT(*) FILTER (WHERE request_type = 'PETTY_CASH')::int AS petty_cash,
            COUNT(*) FILTER (WHERE request_type IN ('EMERGENCY','MAINTENANCE','PRODUCTION_MATERIAL','PROJECT'))::int AS other
     FROM requisitions WHERE company_id = $1 AND tenant_id = $2 AND status = 'SUBMITTED'`,
    [company, ctx.tenantId]
  );
  const byStatus = await client.query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(estimated_total),0)::numeric AS total
     FROM requisitions WHERE company_id = $1 AND tenant_id = $2
     GROUP BY status ORDER BY status`,
    [company, ctx.tenantId]
  );
  const recent = await client.query(
    `${REQUISITION_SELECT} WHERE r.company_id = $1 AND r.tenant_id = $2
     ORDER BY r.created_at DESC LIMIT 10`,
    [company, ctx.tenantId]
  );
  const aging = await client.query(
    `SELECT CASE
              WHEN r.created_at::date < CURRENT_DATE - 7 THEN 'OVER_7_DAYS'
              WHEN r.created_at::date < CURRENT_DATE - 3 THEN '3_TO_7_DAYS'
              ELSE 'WITHIN_3_DAYS'
            END AS bucket, COUNT(*)::int AS count
     FROM requisitions r
     WHERE r.company_id = $1 AND r.tenant_id = $2 AND r.status IN ('SUBMITTED','APPROVED')
     GROUP BY 1`,
    [company, ctx.tenantId]
  );
  return {
    pending: pending.rows[0],
    byStatus: toCamelRows(byStatus.rows),
    aging: toCamelRows(aging.rows),
    recent: toCamelRows(recent.rows),
  };
}

/** Requisition register / aging / fulfillment performance reports. */
export async function requisitionReports(client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>) {
  const company = companyId(ctx);
  const report = String(query.report ?? 'register');
  if (report === 'aging') {
    const res = await client.query(
      `SELECT r.id, r.req_no, r.request_type, r.status, r.created_at::date AS created_date,
              (CURRENT_DATE - r.created_at::date) AS age_days,
              d.name AS department_name, r.estimated_total, r.priority, r.risk_level
       FROM requisitions r LEFT JOIN departments d ON d.id = r.department_id
       WHERE r.company_id = $1 AND r.tenant_id = $2 AND r.status IN ('SUBMITTED','APPROVED')
       ORDER BY age_days DESC LIMIT 200`,
      [company, ctx.tenantId]
    );
    return { report, items: toCamelRows(res.rows) };
  }
  if (report === 'fulfillment') {
    const res = await client.query(
      `SELECT r.id, r.req_no, r.request_type, r.status, r.estimated_total, r.fulfilled_at,
              COUNT(rl.id)::int AS line_count,
              COUNT(rl.id) FILTER (WHERE rl.status IN ('ISSUED','ASSIGNED','PURCHASED'))::int AS fulfilled_lines,
              COUNT(rf.id)::int AS fulfillment_records
       FROM requisitions r
       LEFT JOIN requisition_lines rl ON rl.requisition_id = r.id
       LEFT JOIN requisition_fulfillments rf ON rf.requisition_id = r.id
       WHERE r.company_id = $1 AND r.tenant_id = $2 AND r.status IN ('APPROVED','PARTIALLY_FULFILLED','FULFILLED')
       GROUP BY r.id, r.req_no, r.request_type, r.status, r.estimated_total, r.fulfilled_at, r.created_at
       ORDER BY r.created_at DESC LIMIT 200`,
      [company, ctx.tenantId]
    );
    return { report, items: toCamelRows(res.rows) };
  }
  const status = query.status != null && String(query.status) ? String(query.status).toUpperCase() : null;
  const params: unknown[] = [company, ctx.tenantId];
  const where = status ? ` AND r.status = $3` : '';
  if (status) params.push(status);
  const res = await client.query(
    `${REQUISITION_SELECT} WHERE r.company_id = $1 AND r.tenant_id = $2${where}
     ORDER BY r.created_at DESC LIMIT 500`,
    params
  );
  return { report: 'register', items: toCamelRows(res.rows) };
}

/** Full audit/history timeline for a requisition. */
export async function requisitionHistory(client: pg.PoolClient, ctx: Ctx, id: number) {
  const req = await getRequisition(client, ctx, id);
  const events = await client.query(
    `SELECT id, event_type, entity_type, entity_id, entity_code, user_id, payload, severity, created_at
     FROM system_events
     WHERE entity_type = 'ops.requisitions' AND entity_id = $1
     ORDER BY created_at`,
    [id]
  );
  const actions = await client.query(
    `SELECT aa.*, u.first_name || ' ' || u.last_name AS actor_name
     FROM approval_actions aa LEFT JOIN users u ON u.id = aa.actor_user_id
     WHERE aa.entity_type = 'ops.requisitions' AND aa.entity_id = $1
     ORDER BY aa.created_at`,
    [id]
  );
  return { requisition: req, events: toCamelRows(events.rows), actions: toCamelRows(actions.rows) };
}

/** Requisition summary cards (command center widget). */
export async function requisitionSummary(client: pg.PoolClient, ctx: Ctx) {
  const company = companyId(ctx);
  const res = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS drafts,
       COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int AS pending_approval,
       COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
       COUNT(*) FILTER (WHERE status = 'PARTIALLY_FULFILLED')::int AS partially_fulfilled,
       COUNT(*) FILTER (WHERE status = 'FULFILLED')::int AS fulfilled,
       COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
       COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
       COALESCE(SUM(estimated_total) FILTER (WHERE status IN ('SUBMITTED','APPROVED','PARTIALLY_FULFILLED')),0)::numeric AS in_flight_value
     FROM requisitions WHERE company_id = $1 AND tenant_id = $2`,
    [company, ctx.tenantId]
  );
  return toCamelRow(res.rows[0]);
}
