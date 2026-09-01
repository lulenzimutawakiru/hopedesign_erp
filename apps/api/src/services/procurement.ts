import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ctx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { postMove, productStock } from './inventory.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { notifyUserAdvanced } from './communication.js';
import * as finance from './finance.js';
import { config } from '../config.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_PR_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Browser-safe attachment file types (industrial document register). */
const PR_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/msword',
]);

/** Normalize any date-ish value to an ISO `YYYY-MM-DD` calendar date (or ''). */
function isoDate(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

/** PR numbering engine - prefix / pad / year format come from app_settings (category 'procurement'). */
async function nextPrNo(client: pg.PoolClient, ctx: Ctx, companyId?: number | null): Promise<string> {
  const res = await client.query('SELECT next_pr_no($1,$2) AS code', [ctx.tenantId, companyId ?? ctx.companyId ?? null]);
  return String(res.rows[0].code);
}

/** Resolve the requisition company: the session company, or any company the user's roles grant access to. */
async function resolveRequisitionCompany(client: pg.PoolClient, ctx: Ctx, requested: number | null | undefined): Promise<number | null> {
  const base = ctx.companyId ?? null;
  const wanted = requested ?? base;
  if (!wanted) return null;
  if (wanted === base) return wanted;
  const res = await client.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND company_id = $2 LIMIT 1`,
    [ctx.userId ?? 0, wanted]
  );
  if (res.rows.length === 0) throw forbidden('Not authorized to requisition for that company');
  return wanted;
}

/** Resolve the requisition branch: the session branch, or any branch the user's roles grant.
 *  Branches are validated against the resolved company so a cross-company branch can't be mixed in. */
async function resolveRequisitionBranch(client: pg.PoolClient, ctx: Ctx, requested: number | null | undefined, companyId: number | null | undefined): Promise<number | null> {
  const base = ctx.branchId ?? null;
  const wanted = requested ?? base;
  if (!wanted) return null;
  const br = await client.query(
    `SELECT id FROM branches WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [wanted, ctx.tenantId, companyId ?? ctx.companyId ?? null]
  );
  if (br.rows.length === 0) {
    if (requested != null) throw forbidden('Not authorized to requisition for that branch');
    return null;
  }
  if (wanted === base) return wanted;
  const role = await client.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND branch_id = $2 LIMIT 1`,
    [ctx.userId ?? 0, wanted]
  );
  if (role.rows.length === 0) throw forbidden('Not authorized to requisition for that branch');
  return wanted;
}

/** Resolve the requisition fiscal year: the session fiscal year, or any fiscal year of the resolved company. */
async function resolveRequisitionFiscalYear(client: pg.PoolClient, ctx: Ctx, requested: number | null | undefined, companyId: number | null | undefined): Promise<number | null> {
  let wanted = requested ?? null;
  if (wanted == null) {
    const u = await client.query(
      `SELECT fiscal_year_id FROM users WHERE id = $1`,
      [ctx.userId ?? 0]
    );
    wanted = u.rows.length ? Number(u.rows[0].fiscal_year_id) : null;
  }
  if (!wanted) return null;
  const res = await client.query(
    `SELECT id FROM fiscal_years WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [wanted, ctx.tenantId, companyId ?? ctx.companyId ?? null]
  );
  if (res.rows.length === 0) {
    if (requested != null) throw forbidden('Not authorized to requisition for that fiscal year');
    return null;
  }
  return wanted;
}

/** Resolve the requisition currency: the user's default currency, or any currency on the global currency table.
 *  An explicitly requested currency that isn't on the table is rejected so an unknown code can't slip through. */
async function resolveRequisitionCurrency(client: pg.PoolClient, ctx: Ctx, requested: string | null | undefined): Promise<string> {
  const wanted = (requested ?? '').trim().toUpperCase();
  if (wanted) {
    const res = await client.query(`SELECT code FROM currencies WHERE code = $1`, [wanted]);
    if (res.rows.length === 0) throw forbidden('Not authorized to requisition in that currency');
    return wanted;
  }
  const u = await client.query(`SELECT default_currency_code FROM users WHERE id = $1`, [ctx.userId ?? 0]);
  const def = u.rows.length ? String(u.rows[0].default_currency_code ?? '') : '';
  if (def) {
    const res = await client.query(`SELECT code FROM currencies WHERE code = $1`, [def]);
    if (res.rows.length) return def;
  }
  return 'UGX';
}

/** Resolve the requisition tax treatment: the user's default tax code, or any active tax code of the resolved company.
 *  An explicitly requested code that isn't on the company's active tax master is rejected so an unknown treatment can't slip through. */
async function resolveRequisitionTax(
  client: pg.PoolClient,
  ctx: Ctx,
  requested: string | null | undefined,
  companyId: number | null | undefined
): Promise<{ code: string; rate: number }> {
  const scopeCompany = companyId ?? ctx.companyId ?? null;
  const wanted = (requested ?? '').trim().toUpperCase();
  if (wanted) {
    const res = await client.query(
      `SELECT code, rate FROM taxes WHERE company_id = $1 AND tenant_id = $2 AND is_active = true AND code = $3`,
      [scopeCompany, ctx.tenantId, wanted]
    );
    if (res.rows.length === 0) throw forbidden('Not authorized to requisition with that tax treatment');
    return { code: String(res.rows[0].code), rate: Number(res.rows[0].rate) || 0 };
  }
  const u = await client.query(`SELECT default_tax_code FROM users WHERE id = $1`, [ctx.userId ?? 0]);
  const def = u.rows.length ? String(u.rows[0].default_tax_code ?? '') : '';
  if (def) {
    const res = await client.query(
      `SELECT code, rate FROM taxes WHERE company_id = $1 AND tenant_id = $2 AND is_active = true AND code = $3`,
      [scopeCompany, ctx.tenantId, def]
    );
    if (res.rows.length) return { code: String(res.rows[0].code), rate: Number(res.rows[0].rate) || 0 };
  }
  const fallback = await client.query(
    `SELECT code, rate FROM taxes WHERE company_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY rate DESC, code LIMIT 1`,
    [scopeCompany, ctx.tenantId]
  );
  if (fallback.rows.length) return { code: String(fallback.rows[0].code), rate: Number(fallback.rows[0].rate) || 0 };
  return { code: 'VAT18', rate: 0 };
}

export async function warehouseByType(client: pg.PoolClient, ctx: Ctx, productType: string): Promise<number> {
  const code = productType === 'SECURITY_ITEM' ? 'SEC-WH' : ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING', 'CONSUMABLE', 'SPARE_PART'].includes(productType) ? 'RAW-MAT' : 'FG-WH';
  const res = await client.query(`SELECT id FROM warehouses WHERE company_id = $1 AND code = $2`, [ctx.companyId, code]);
  if (res.rows.length === 0) throw badRequest(`Warehouse ${code} not found`);
  return Number(res.rows[0].id);
}

async function defaultBin(client: pg.PoolClient, _ctx: Ctx, warehouseId: number): Promise<number | null> {
  const res = await client.query(
    `SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1`,
    [warehouseId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

async function productMeta(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const res = await client.query(
    `SELECT p.id, p.code, p.name, p.type, p.unit_id, p.standard_cost, p.description,
            pc.name AS category_name, pcat.name AS category_parent_name
     FROM products p
     LEFT JOIN product_categories pc ON pc.id = p.category_id
     LEFT JOIN product_categories pcat ON pcat.id = pc.parent_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest(`Product ${productId} not found`);
  return res.rows[0];
}

/** Register a new supplier (PENDING; workflow approves). */
export async function createSupplier(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    name: string;
    supplierType?: string;
    tin?: string | null;
    vrn?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    address?: string | null;
    paymentTermsDays?: number;
    currency?: string;
    defaultLeadTimeDays?: number;
    securityCleared?: boolean;
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  const code = await nextDoc(client, ctx, 'SUP');
  const ins = await client.query(
    `INSERT INTO suppliers
       (company_id, tenant_id, branch_id, code, name, supplier_type, tin, vrn, phone, email, address,
        payment_terms_days, default_lead_time_days, status, security_cleared, website, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14,$15,$16) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, code, input.name,
      input.supplierType ?? 'RAW_MATERIAL', input.tin ?? null, input.vrn ?? null, input.phone ?? null,
      input.email ?? null, input.address ?? null, input.paymentTermsDays ?? 30,
      input.defaultLeadTimeDays ?? 7, input.securityCleared ?? false, input.website ?? null, input.currency ?? 'UGX',
    ]
  );
  const supplierId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'procurement.supplier_created', entityType: 'suppliers', entityId: supplierId, entityCode: code });
  return { supplierId, code };
}

export async function submitSupplier(client: pg.PoolClient, ctx: Ctx, supplierId: number) {
  const res = await client.query(
    `UPDATE suppliers SET status = 'SUBMITTED' WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING code`,
    [supplierId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Supplier not found or not PENDING');
  await startWorkflow(client, ctx, { entityType: 'procurement.suppliers', entityId: supplierId, entityCode: String(res.rows[0].code) });
  return { supplierId, code: String(res.rows[0].code) };
}

interface RequisitionItemInput {
  productId: number;
  quantity: number;
  unitId?: number | null;
  suggestedSupplierId?: number | null;
  estimatedCost?: number;
  discountRate?: number;
  needBy?: string | null;
  description?: string | null;
  specification?: string | null;
  category?: string | null;
  subcategory?: string | null;
  taxRate?: number;
  glAccountId?: number | null;
}

interface RequisitionInput {
  requestedDate?: string;
  requiredDate?: string | null;
  departmentId?: number | null;
  budgetCode?: string | null;
  notes?: string | null;
  title?: string | null;
  description?: string | null;
  businessJustification?: string | null;
  confidentialityLevel?: string | null;
  emergencyPurchase?: boolean | null;
  recurringPurchase?: boolean | null;
  companyId?: number | null;
  branchId?: number | null;
  fiscalYearId?: number | null;
  category?: string;
  urgency?: string;
  currencyCode?: string;
  taxCode?: string | null;
  taxIncluded?: boolean | null;
  discountRate?: number;
  deliveryCost?: number;
  warehouseId?: number | null;
  deliveryLocation?: string | null;
  incoterm?: string | null;
  shipToAddress?: string | null;
  deliveryInstruction?: string | null;
  paymentTerms?: string | null;
  costCentreId?: number | null;
  accountId?: number | null;
  items: RequisitionItemInput[];
}

/** Latest exchange rate for a currency into UGX (base). Defaults to 1. */
async function exchangeRate(client: pg.PoolClient, _ctx: Ctx, currencyCode: string): Promise<number> {
  if (!currencyCode || currencyCode === 'UGX') return 1;
  const res = await client.query(
    `SELECT rate FROM exchange_rates WHERE currency_code = $1 AND rate_date <= CURRENT_DATE
     ORDER BY rate_date DESC LIMIT 1`,
    [currencyCode]
  );
  return res.rows.length ? Number(res.rows[0].rate) || 1 : 1;
}

/** Enforce budget availability at submit time (PASS / FAIL / EXEMPT). */
async function checkBudget(
  client: pg.PoolClient,
  ctx: Ctx,
  pr: { budget_code: string | null; cost_centre_id: number | null; account_id?: number | null },
  baseTotal: number
): Promise<{ status: string; variance: number | null; budgetId?: number | null; accountId?: number | null }> {
  if (pr.account_id) {
    const pos = await finance.budgetPosition(client, ctx, Number(pr.account_id));
    if (pos.result === 'NONE') return { status: 'EXEMPT', variance: null, budgetId: pos.budgetId, accountId: Number(pr.account_id) };
    const variance = round2(pos.available - baseTotal);
    return {
      status: variance >= 0 ? 'PASS' : 'FAIL',
      variance,
      budgetId: pos.budgetId,
      accountId: Number(pr.account_id),
    };
  }
  const code = pr.budget_code ? String(pr.budget_code) : null;
  const cc = pr.cost_centre_id ? Number(pr.cost_centre_id) : null;
  if (!code && !cc) return { status: 'EXEMPT', variance: null };
  const res = await client.query(
    `SELECT b.id, b.amount,
            COALESCE((SELECT sum(c.amount) FROM budget_commitments c WHERE c.budget_id = b.id AND c.status = 'COMMITTED'),0) AS committed
     FROM budgets b
     WHERE b.company_id = $1 AND b.status IN ('APPROVED','ACTIVE')
       AND ($2::text IS NULL OR b.budget_no = $2)
       AND ($3::bigint IS NULL OR b.cost_centre_id = $3)
       AND (b.period_start IS NULL OR b.period_end IS NULL OR CURRENT_DATE BETWEEN b.period_start AND b.period_end)
     ORDER BY b.id DESC LIMIT 1`,
    [ctx.companyId, code, cc]
  );
  if (res.rows.length === 0) {
    return { status: code ? 'FAIL' : 'EXEMPT', variance: null };
  }
  const available = Number(res.rows[0].amount) - Number(res.rows[0].committed);
  const variance = round2(available - baseTotal);
  return { status: variance >= 0 ? 'PASS' : 'FAIL', variance, budgetId: Number(res.rows[0].id) };
}

/** Remaining budget (approved minus committed) for a requisition's budget line. */
async function budgetRemaining(
  client: pg.PoolClient,
  ctx: Ctx,
  pr: { budget_code: string | null; cost_centre_id: number | null }
): Promise<{ budgetNo: string; approved: number; committed: number; available: number } | null> {
  const code = pr.budget_code ? String(pr.budget_code) : null;
  const cc = pr.cost_centre_id ? Number(pr.cost_centre_id) : null;
  if (!code && !cc) return null;
  const res = await client.query(
    `SELECT b.budget_no, b.amount,
            COALESCE((SELECT sum(bl.amount) FROM budget_lines bl WHERE bl.budget_id = b.id),0) AS committed
     FROM budgets b
     WHERE b.company_id = $1 AND b.status IN ('APPROVED','ACTIVE')
       AND ($2::text IS NULL OR b.budget_no = $2)
       AND ($3::bigint IS NULL OR b.cost_centre_id = $3)
       AND (b.period_start IS NULL OR b.period_end IS NULL OR CURRENT_DATE BETWEEN b.period_start AND b.period_end)
     ORDER BY b.id DESC LIMIT 1`,
    [ctx.companyId, code, cc]
  );
  if (res.rows.length === 0) return null;
  const approved = Number(res.rows[0].amount);
  const committed = Number(res.rows[0].committed);
  return {
    budgetNo: String(res.rows[0].budget_no),
    approved,
    committed,
    available: round2(approved - committed),
  };
}

/** Formal PR state machine: the only legal status transitions. */
const PR_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'ON_HOLD', 'CANCELLED', 'CLOSED'],
  SUBMITTED: ['PENDING_APPROVAL', 'PENDING_BUDGET', 'PENDING_PROCUREMENT', 'PENDING_FINANCE', 'APPROVED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'CANCELLED'],
  PENDING_APPROVAL: ['PENDING_BUDGET', 'PENDING_PROCUREMENT', 'PENDING_FINANCE', 'APPROVED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'CANCELLED'],
  PENDING_BUDGET: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'CANCELLED'],
  PENDING_PROCUREMENT: ['APPROVED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'CANCELLED', 'RFQ_CREATED', 'PARTIALLY_CONVERTED', 'FULLY_CONVERTED'],
  PENDING_FINANCE: ['APPROVED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'CANCELLED'],
  APPROVED: ['ON_HOLD', 'CANCELLED', 'RFQ_CREATED', 'PARTIALLY_ORDERED', 'PARTIALLY_CONVERTED', 'FULLY_CONVERTED', 'CLOSED'],
  REJECTED: ['DRAFT', 'CANCELLED', 'CLOSED'],
  RETURNED: ['DRAFT', 'SUBMITTED', 'CANCELLED', 'CLOSED'],
  ON_HOLD: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'RFQ_CREATED', 'PARTIALLY_CONVERTED', 'FULLY_CONVERTED', 'CLOSED'],
  RFQ_CREATED: ['ON_HOLD', 'CANCELLED', 'PARTIALLY_CONVERTED', 'FULLY_CONVERTED', 'CLOSED'],
  PARTIALLY_ORDERED: ['PARTIALLY_CONVERTED', 'FULLY_CONVERTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED'],
  PARTIALLY_CONVERTED: ['ON_HOLD', 'CANCELLED', 'FULLY_CONVERTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED'],
  FULLY_CONVERTED: ['PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED'],
  CONVERTED: ['PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED'],
  PARTIALLY_FULFILLED: ['FULFILLED', 'CLOSED'],
  FULFILLED: ['CLOSED'],
  CANCELLED: ['CLOSED'],
  CLOSED: [],
};

/** Reject illegal transitions so invalid workflow moves are impossible. */
function assertPrTransition(from: string, to: string): void {
  if (from === to) return;
  const allowed = PR_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw badRequest(`Illegal requisition status transition: ${from} -> ${to}`);
  }
}

/** Persist a status change to the history trail, event bus and audit log. */
async function recordPrTransition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { requisitionId: number; from: string | null; to: string; comment?: string | null; prNo?: string | null }
): Promise<void> {
  await client.query(
    `INSERT INTO pr_status_history (requisition_id, from_status, to_status, changed_by, comment)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.requisitionId, input.from, input.to, ctx.userId ?? null, input.comment ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'procurement.requisition_status_changed',
    entityType: 'purchase_requisitions',
    entityId: input.requisitionId,
    entityCode: input.prNo ?? null,
    payload: { from: input.from, to: input.to, comment: input.comment ?? null },
  });
  await logAudit(client, ctx, {
    action: `status:${input.to.toLowerCase()}`,
    resource: 'purchase_requisitions',
    recordId: input.requisitionId,
    recordCode: input.prNo ?? null,
    oldValues: { status: input.from },
    newValues: { status: input.to },
    metadata: { comment: input.comment ?? null },
  });
}

async function insertRequisitionItems(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  currency: string,
  rate: number,
  items: RequisitionItemInput[],
  headerTaxRate = 0,
  headerDiscountRate = 0
): Promise<{ total: number; discount: number }> {
  let total = 0;
  let discount = 0;
  for (const item of items) {
    const product = await productMeta(client, ctx, item.productId);
    const estimated = Number(item.estimatedCost ?? product.standard_cost ?? 0);
    const taxRate = Number(item.taxRate ?? headerTaxRate);
    const discountRate = Math.min(100, Math.max(0, Number(item.discountRate ?? headerDiscountRate)));
    const base = estimated * Number(item.quantity);
    const discountAmount = round2(base * (discountRate / 100));
    const taxable = base - discountAmount;
    const taxAmount = round2(taxable * (taxRate / 100));
    const lineTotal = round2(base - discountAmount + taxAmount);
    total += lineTotal;
    discount += discountAmount;
    await client.query(
      `INSERT INTO purchase_requisition_items
         (requisition_id, product_id, quantity, unit_id, suggested_supplier_id, estimated_cost, need_by,
          description, specification, category, subcategory, currency_code, exchange_rate, tax_rate, tax_amount, discount_percent, discount_amount, line_total, gl_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        requisitionId, item.productId, item.quantity, item.unitId ?? product.unit_id ?? null,
        item.suggestedSupplierId ?? null, estimated, item.needBy ?? null, item.description ?? null,
        item.specification ?? product.description ?? null,
        item.category ?? product.category_name ?? null,
        item.subcategory ?? product.category_parent_name ?? null,
        currency, rate, taxRate, taxAmount, discountRate, discountAmount, lineTotal, item.glAccountId ?? null,
      ]
    );
  }
  return { total: round2(total), discount: round2(discount) };
}

/** Create a purchase requisition (DRAFT). */
export async function createRequisition(client: pg.PoolClient, ctx: Ctx, input: RequisitionInput) {
  const companyId = await resolveRequisitionCompany(client, ctx, input.companyId ?? null);
  if (!companyId) throw badRequest('Company context required');
  const branchId = await resolveRequisitionBranch(client, ctx, input.branchId ?? null, companyId);
  const fiscalYearId = await resolveRequisitionFiscalYear(client, ctx, input.fiscalYearId ?? null, companyId);
  if (!input.items?.length) throw badRequest('Add at least one line');
  const currency = await resolveRequisitionCurrency(client, ctx, input.currencyCode ?? null);
  const tax = await resolveRequisitionTax(client, ctx, input.taxCode ?? null, companyId);
  const discountRate = Math.min(100, Math.max(0, Number(input.discountRate ?? 0)));
  const deliveryCost = Math.max(0, Number(input.deliveryCost ?? 0));
  const rate = await exchangeRate(client, ctx, currency);
  const prNo = await nextPrNo(client, ctx, companyId);
  const requestedDate = isoDate(input.requestedDate) || new Date().toISOString().slice(0, 10);
  const requiredDate = isoDate(input.requiredDate) || null;
  if (requiredDate && requiredDate < requestedDate) {
    throw badRequest('Required date cannot be before the request date');
  }
  const ins = await client.query(
    `INSERT INTO purchase_requisitions
       (company_id, tenant_id, branch_id, department_id, pr_no, requested_by, requested_date, required_date,
        status, budget_code, notes, title, description, category, urgency, currency_code, exchange_rate,
        warehouse_id, delivery_location, incoterm, ship_to_address, delivery_instruction, payment_terms,
        cost_centre_id, account_id, business_justification, confidentiality_level, emergency_purchase, recurring_purchase, fiscal_year_id,
        tax_code, tax_rate, tax_included, discount_rate, discount_amount, delivery_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
     RETURNING id`,
    [
      companyId, ctx.tenantId, branchId, input.departmentId ?? null, prNo,
      ctx.userId ?? 0, requestedDate,
      requiredDate, input.budgetCode ?? null, input.notes ?? null,
      input.title ?? null, input.description ?? null, input.category ?? 'GOODS',
      input.urgency ?? 'NORMAL', currency, rate, input.warehouseId ?? null,
      input.deliveryLocation ?? null, input.incoterm ?? null, input.shipToAddress ?? null,
      input.deliveryInstruction ?? null, input.paymentTerms ?? null,
      input.costCentreId ?? null, input.accountId ?? null, input.businessJustification ?? null, input.confidentialityLevel ?? null, input.emergencyPurchase ?? false, input.recurringPurchase ?? false, fiscalYearId,
      tax.code, tax.rate, input.taxIncluded === true, discountRate, 0, deliveryCost,
    ]
  );
  const requisitionId = Number(ins.rows[0].id);
  const { total, discount } = await insertRequisitionItems(client, ctx, requisitionId, currency, rate, input.items, tax.rate, discountRate);
  const baseTotal = round2(total / (rate || 1));
  await client.query(
    `UPDATE purchase_requisitions SET total_estimated = $1, base_total = $2, discount_amount = $3 WHERE id = $4`,
    [total, baseTotal, discount, requisitionId]
  );
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: null,
    to: 'DRAFT',
    comment: 'Requisition created',
    prNo,
  });
  await emitEvent(client, ctx, {
    eventType: 'procurement.requisition_created',
    entityType: 'purchase_requisitions',
    entityId: requisitionId,
    entityCode: prNo,
    payload: { total, baseTotal, currency },
  });
  return { requisitionId, prNo, total, baseTotal, currency };
}

/** Submit a DRAFT requisition: recompute totals, run the budget check, start approval. */
export async function submitRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `SELECT * FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' FOR UPDATE`,
    [requisitionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Requisition not found or not DRAFT');
  const pr = res.rows[0];
  const totals = await client.query(
    `SELECT COALESCE(sum(line_total),0)::numeric AS total_estimated,
            COALESCE(sum(estimated_cost * quantity),0)::numeric AS raw_total
     FROM purchase_requisition_items WHERE requisition_id = $1`,
    [requisitionId]
  );
  const totalEstimated = Number(totals.rows[0].total_estimated) || Number(totals.rows[0].raw_total);
  const rate = await exchangeRate(client, ctx, String(pr.currency_code ?? 'UGX'));
  const baseTotal = round2(totalEstimated / (rate || 1));
  const budget = await checkBudget(client, ctx, pr, baseTotal);
  if (budget.status === 'FAIL') {
    throw badRequest(
      `Budget exceeded: available variance ${budget.variance ?? 0}. Reduce the requisition or revise the budget.`
    );
  }
  await client.query(
    `UPDATE purchase_requisitions
     SET status = 'SUBMITTED', total_estimated = $1, base_total = $2,
         budget_check_status = $3, budget_variance = $4, budget_validated = true
     WHERE id = $5`,
    [round2(totalEstimated), baseTotal, budget.status, budget.variance, requisitionId]
  );
  if (budget.status === 'PASS' && budget.budgetId && budget.accountId) {
    const existing = await client.query(
      `SELECT id FROM budget_commitments
       WHERE tenant_id = $1 AND doc_type = 'PR' AND doc_ref_id = $2 AND account_id = $3`,
      [ctx.tenantId, requisitionId, budget.accountId]
    );
    if (existing.rows.length) {
      await client.query(
        `UPDATE budget_commitments SET amount = $2, status = 'COMMITTED', released_at = NULL WHERE id = $1`,
        [existing.rows[0].id, baseTotal]
      );
    } else {
      await client.query(
        `INSERT INTO budget_commitments
           (company_id, tenant_id, budget_id, account_id, doc_type, doc_ref_type, doc_ref_id, doc_ref_code, amount, status, created_by)
         VALUES ($1,$2,$3,$4,'PR','purchase_requisitions',$5,$6,$7,'COMMITTED',$8)`,
        [ctx.companyId, ctx.tenantId, budget.budgetId, budget.accountId, requisitionId, String(pr.pr_no), baseTotal, ctx.userId ?? null]
      );
    }
  }
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: 'DRAFT',
    to: 'SUBMITTED',
    comment: `Submitted for approval (budget check ${budget.status})`,
    prNo: String(pr.pr_no),
  });
  await startWorkflow(client, ctx, {
    entityType: 'procurement.requisitions',
    entityId: requisitionId,
    entityCode: String(pr.pr_no),
    amount: baseTotal,
  });
  return { requisitionId, prNo: String(pr.pr_no), total: round2(totalEstimated), baseTotal, budget: budget.status };
}

/** Replace a DRAFT requisition header + lines. */
export async function updateRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number, input: RequisitionInput) {
  const existing = await client.query(
    `SELECT * FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'`,
    [requisitionId, ctx.tenantId]
  );
  if (existing.rows.length === 0) throw badRequest('Requisition not found or not editable (must be DRAFT)');
  if (!input.items?.length) throw badRequest('Add at least one line');
  const companyId = await resolveRequisitionCompany(client, ctx, input.companyId ?? null);
  if (companyId && companyId !== Number(existing.rows[0].company_id)) {
    await client.query(
      `UPDATE purchase_requisitions SET company_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [companyId, requisitionId, ctx.tenantId]
    );
  }
  const branchId = await resolveRequisitionBranch(client, ctx, input.branchId ?? null, companyId);
  if (branchId && branchId !== Number(existing.rows[0].branch_id)) {
    await client.query(
      `UPDATE purchase_requisitions SET branch_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [branchId, requisitionId, ctx.tenantId]
    );
  }
  const fiscalYearId = await resolveRequisitionFiscalYear(client, ctx, input.fiscalYearId ?? null, companyId);
  if (fiscalYearId && fiscalYearId !== Number(existing.rows[0].fiscal_year_id)) {
    await client.query(
      `UPDATE purchase_requisitions SET fiscal_year_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [fiscalYearId, requisitionId, ctx.tenantId]
    );
  }
  const currency = input.currencyCode != null
    ? await resolveRequisitionCurrency(client, ctx, input.currencyCode)
    : String(existing.rows[0].currency_code ?? 'UGX');
  const rate = await exchangeRate(client, ctx, currency);
  const tax = input.taxCode != null
    ? await resolveRequisitionTax(client, ctx, input.taxCode, companyId)
    : { code: String(existing.rows[0].tax_code ?? 'VAT18'), rate: Number(existing.rows[0].tax_rate ?? 0) };
  const taxIncluded = input.taxIncluded != null ? input.taxIncluded === true : existing.rows[0].tax_included === true;
  const discountRate = Math.min(100, Math.max(0, Number(input.discountRate ?? existing.rows[0].discount_rate ?? 0)));
  const deliveryCost = Math.max(0, Number(input.deliveryCost ?? existing.rows[0].delivery_cost ?? 0));
  const requestedDate = isoDate(input.requestedDate) || isoDate(existing.rows[0].requested_date) || new Date().toISOString().slice(0, 10);
  const requiredDate = isoDate(input.requiredDate) || null;
  if (requiredDate && requiredDate < requestedDate) {
    throw badRequest('Required date cannot be before the request date');
  }
  await client.query(
    `UPDATE purchase_requisitions SET
       requested_date = $1, required_date = $2, department_id = $3, budget_code = $4, notes = $5,
       title = $6, description = $7, category = $8, urgency = $9, currency_code = $10, exchange_rate = $11,
       warehouse_id = $12, delivery_location = $13, incoterm = $14, ship_to_address = $15,
       delivery_instruction = $16, payment_terms = $17, cost_centre_id = $18, account_id = $19,
       business_justification = $20,
       confidentiality_level = $21,
       emergency_purchase = $22,
       recurring_purchase = $23,
       tax_code = $24, tax_rate = $25, tax_included = $26,
       discount_rate = $27,
       delivery_cost = $28,
       total_estimated = 0, base_total = 0, budget_check_status = 'EXEMPT', budget_variance = NULL
     WHERE id = $29 AND tenant_id = $30`,
    [
      requestedDate,
      requiredDate, input.departmentId ?? null, input.budgetCode ?? null, input.notes ?? null,
      input.title ?? null, input.description ?? null, input.category ?? 'GOODS',
      input.urgency ?? 'NORMAL', currency, rate, input.warehouseId ?? null,
      input.deliveryLocation ?? null, input.incoterm ?? null, input.shipToAddress ?? null,
      input.deliveryInstruction ?? null, input.paymentTerms ?? null,
      input.costCentreId ?? null, input.accountId ?? null, input.businessJustification ?? null, input.confidentialityLevel ?? null, input.emergencyPurchase ?? false, input.recurringPurchase ?? false,
      tax.code, tax.rate, taxIncluded, discountRate, deliveryCost, requisitionId, ctx.tenantId,
    ]
  );
  await client.query(`DELETE FROM purchase_requisition_items WHERE requisition_id = $1`, [requisitionId]);
  const { total, discount } = await insertRequisitionItems(client, ctx, requisitionId, currency, rate, input.items, tax.rate, discountRate);
  const baseTotal = round2(total / (rate || 1));
  await client.query(
    `UPDATE purchase_requisitions SET total_estimated = $1, base_total = $2, discount_amount = $3 WHERE id = $4`,
    [total, baseTotal, discount, requisitionId]
  );
  await emitEvent(client, ctx, {
    eventType: 'procurement.requisition_updated',
    entityType: 'purchase_requisitions',
    entityId: requisitionId,
    entityCode: String(existing.rows[0].pr_no),
    payload: { total, baseTotal, currency },
  });
  return { requisitionId, prNo: String(existing.rows[0].pr_no), total, baseTotal, currency };
}

/** Send a REJECTED requisition back to DRAFT for amendment and resubmission. */
export async function reopenRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `UPDATE purchase_requisitions
     SET status = 'DRAFT', rejection_reason = NULL, budget_check_status = 'EXEMPT',
         budget_variance = NULL, budget_validated = false
     WHERE id = $1 AND tenant_id = $2 AND status = 'REJECTED'
     RETURNING pr_no`,
    [requisitionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Requisition not found or not REJECTED');
  const prNo = String(res.rows[0].pr_no);
  await emitEvent(client, ctx, {
    eventType: 'procurement.requisition_reopened',
    entityType: 'purchase_requisitions',
    entityId: requisitionId,
    entityCode: prNo,
  });
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: 'REJECTED',
    to: 'DRAFT',
    comment: 'Requisition reopened for amendment',
    prNo,
  });
  return { requisitionId, prNo, status: 'DRAFT' };
}

/** Reference data for the PR composer (departments, warehouses, GL, budgets, FX). */
export async function requisitionMeta(client: pg.PoolClient, ctx: Ctx, companyId?: number | null, branchId?: number | null) {
  const scopeCompany = (await resolveRequisitionCompany(client, ctx, companyId ?? null)) ?? ctx.companyId;
  const scopeBranch = (await resolveRequisitionBranch(client, ctx, branchId ?? null, scopeCompany)) ?? null;
  const scopeFiscalYear = (await resolveRequisitionFiscalYear(client, ctx, null, scopeCompany)) ?? null;
  const [depts, whs, ccs, accts, budgets, rates, currencyRows, products, companies, branches, fiscalYears, units, taxes] = await Promise.all([
    client.query(`SELECT id, code, name FROM departments WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' AND ($3::bigint IS NULL OR branch_id = $3 OR branch_id IS NULL) ORDER BY name`, [scopeCompany, ctx.tenantId, scopeBranch]),
    client.query(`SELECT id, code, name FROM warehouses WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' AND ($3::bigint IS NULL OR branch_id = $3 OR branch_id IS NULL) ORDER BY name`, [scopeCompany, ctx.tenantId, scopeBranch]),
    client.query(`SELECT id, code, name FROM cost_centres WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' ORDER BY name`, [scopeCompany, ctx.tenantId]),
    client.query(`SELECT id, code, name FROM chart_of_accounts WHERE company_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY code`, [scopeCompany, ctx.tenantId]),
    client.query(`SELECT id, budget_no, cost_centre_id, amount, status FROM budgets WHERE company_id = $1 AND tenant_id = $2 AND status IN ('APPROVED','ACTIVE') AND ($3::bigint IS NULL OR fiscal_year_id = $3) ORDER BY budget_no`, [scopeCompany, ctx.tenantId, scopeFiscalYear]),
    client.query(`SELECT DISTINCT ON (currency_code) currency_code, rate FROM exchange_rates ORDER BY currency_code, rate_date DESC`, []),
    client.query(`SELECT code, name, symbol, is_base FROM currencies ORDER BY is_base DESC, code`, []),
    client.query(`SELECT p.id, p.code, p.name, p.standard_cost, p.unit_id,
                         u.code AS unit_code, u.name AS unit_name,
                         pc.name AS category_name, pcat.name AS category_parent_name
                  FROM products p
                  LEFT JOIN units u ON u.id = p.unit_id
                  LEFT JOIN product_categories pc ON pc.id = p.category_id
                  LEFT JOIN product_categories pcat ON pcat.id = pc.parent_id
                  WHERE p.company_id = $1 AND p.tenant_id = $2 AND p.status = 'ACTIVE' ORDER BY p.name`, [scopeCompany, ctx.tenantId]),
    client.query(`SELECT DISTINCT c.id, c.code, c.name FROM companies c LEFT JOIN user_roles ur ON ur.company_id = c.id AND ur.user_id = $1 WHERE c.tenant_id = $2 AND (c.id = $3 OR ur.role_id IS NOT NULL) ORDER BY c.name`, [ctx.userId ?? 0, ctx.tenantId, ctx.companyId]),
    client.query(`SELECT DISTINCT b.id, b.code, b.name FROM branches b LEFT JOIN user_roles ur ON ur.branch_id = b.id AND ur.user_id = $1 WHERE b.tenant_id = $2 AND b.company_id = $3 AND (b.id = $4 OR ur.role_id IS NOT NULL) ORDER BY b.name`, [ctx.userId ?? 0, ctx.tenantId, scopeCompany, ctx.branchId]),
    client.query(`SELECT id, code, name, status, is_current FROM fiscal_years WHERE tenant_id = $1 AND company_id = $2 ORDER BY is_current DESC, name`, [ctx.tenantId, scopeCompany]),
    client.query(`SELECT id, code, name FROM units WHERE company_id = $1 AND tenant_id = $2 ORDER BY code`, [scopeCompany, ctx.tenantId]),
    client.query(`SELECT code, name, tax_type, rate FROM taxes WHERE company_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY rate DESC, code`, [scopeCompany, ctx.tenantId]),
  ]);
  const currencies: { code: string; name: string; symbol: string; rate: number; isBase: boolean }[] = [];
  for (const row of currencyRows.rows) {
    const code = String(row.code);
    const fx = rates.rows.find((r) => String(r.currency_code) === code);
    currencies.push({
      code,
      name: String(row.name ?? ''),
      symbol: String(row.symbol ?? ''),
      rate: fx ? Number(fx.rate) || 1 : 1,
      isBase: Boolean(row.is_base),
    });
  }
  return {
    departments: toCamelRows(depts.rows),
    warehouses: toCamelRows(whs.rows),
    costCentres: toCamelRows(ccs.rows),
    accounts: toCamelRows(accts.rows),
    budgets: toCamelRows(budgets.rows),
    currencies,
    products: toCamelRows(products.rows),
    companies: toCamelRows(companies.rows),
    branches: toCamelRows(branches.rows),
    fiscalYears: toCamelRows(fiscalYears.rows),
    units: toCamelRows(units.rows),
    taxes: toCamelRows(taxes.rows),
  };
}

/** Cancel a requisition before it is converted. Pending approvals are withdrawn. */
export async function cancelRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `UPDATE purchase_requisitions SET status = 'CANCELLED', cancelled_by = $3, cancelled_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT','SUBMITTED')
       AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.requisition_id = $1)
     RETURNING pr_no, status`,
    [requisitionId, ctx.tenantId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) {
    throw badRequest('Requisition cannot be cancelled (already converted to a purchase order or wrong status)');
  }
  const prNo = String(res.rows[0].pr_no);
  const inst = await client.query(
    `UPDATE workflow_instances SET status = 'CANCELLED', completed_at = now()
     WHERE tenant_id = $1 AND entity_type = 'procurement.requisitions' AND entity_id = $2 AND status = 'RUNNING'
     RETURNING id`,
    [ctx.tenantId, requisitionId]
  );
  if (inst.rows.length) {
    await client.query(
      `UPDATE approval_tasks SET status = 'REJECTED', comment = 'Cancelled by requester', decided_at = now()
       WHERE instance_id = $1 AND status = 'PENDING'`,
      [Number(inst.rows[0].id)]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'procurement.requisition_cancelled',
    entityType: 'purchase_requisitions',
    entityId: requisitionId,
    entityCode: prNo,
    severity: 'WARN',
  });
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: String(res.rows[0].status),
    to: 'CANCELLED',
    comment: 'Cancelled by requester',
    prNo,
  });
  return { requisitionId, prNo, status: 'CANCELLED' };
}

/** Create an RFQ from an approved requisition. */
export async function createRfq(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { requisitionId: number; supplierIds: number[]; closingDate?: string | null; notes?: string | null }
) {
  const pr = await client.query(
    `SELECT * FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 AND status = 'APPROVED'`,
    [input.requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw badRequest('Requisition not found or not APPROVED');
  const items = await client.query(`SELECT * FROM purchase_requisition_items WHERE requisition_id = $1`, [input.requisitionId]);
  if (items.rows.length === 0) throw badRequest('Requisition has no items');
  const rfqNo = await nextDoc(client, ctx, 'RFQ');
  const ins = await client.query(
    `INSERT INTO rfqs (company_id, tenant_id, branch_id, rfq_no, status, issue_date, closing_date, notes, requisition_id)
     VALUES ($1,$2,$3,$4,'ISSUED',$5,$6,$7,$8) RETURNING id`,
    [ctx.companyId, ctx.tenantId, ctx.branchId ?? null, rfqNo, new Date().toISOString().slice(0, 10), input.closingDate ?? null, input.notes ?? null, input.requisitionId]
  );
  const rfqId = Number(ins.rows[0].id);
  for (const item of items.rows) {
    await client.query(
      `INSERT INTO rfq_items (rfq_id, product_id, quantity, unit_id, target_price, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rfqId, item.product_id, item.quantity, item.unit_id ?? null, item.estimated_cost, item.notes ?? null]
    );
  }
  for (const supplierId of input.supplierIds) {
    await client.query(`INSERT INTO rfq_suppliers (rfq_id, supplier_id) VALUES ($1,$2)`, [rfqId, supplierId]);
  }
  await emitEvent(client, ctx, { eventType: 'procurement.rfq_issued', entityType: 'rfqs', entityId: rfqId, entityCode: rfqNo });
  return { rfqId, rfqNo };
}

/** Record a supplier quotation against an RFQ. */
export async function createSupplierQuotation(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    rfqId: number;
    supplierId: number;
    quoteDate?: string;
    validUntil?: string | null;
    items: { rfqItemId?: number | null; productId: number; quantity: number; unitPrice: number; leadTimeDays?: number | null }[];
  }
) {
  const quoteNo = await nextDoc(client, ctx, 'SQ');
  let total = 0;
  const ins = await client.query(
    `INSERT INTO supplier_quotations
       (company_id, tenant_id, rfq_id, supplier_id, quote_no, quote_date, valid_until, status, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'RECEIVED',$8) RETURNING id`,
    [ctx.companyId, ctx.tenantId, input.rfqId, input.supplierId, quoteNo, input.quoteDate ?? new Date().toISOString().slice(0, 10), input.validUntil ?? null, 0]
  );
  const quotationId = Number(ins.rows[0].id);
  for (const item of input.items) {
    const lineTotal = Number(item.quantity) * Number(item.unitPrice);
    total += lineTotal;
    await client.query(
      `INSERT INTO supplier_quotation_items (quotation_id, rfq_item_id, product_id, quantity, unit_price, lead_time_days, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [quotationId, item.rfqItemId ?? null, item.productId, item.quantity, item.unitPrice, item.leadTimeDays ?? null, lineTotal]
    );
    await client.query(
      `INSERT INTO supplier_price_history (tenant_id, company_id, supplier_id, product_id, unit_price, currency, effective_date, source, source_id, source_no, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'QUOTATION',$8,$9,NULL)
       ON CONFLICT (source, source_id, product_id) DO NOTHING`,
      [ctx.tenantId, ctx.companyId, input.supplierId, item.productId, item.unitPrice, 'UGX', input.quoteDate ?? new Date().toISOString().slice(0, 10), quotationId, quoteNo]
    );
  }
  await client.query(`UPDATE supplier_quotations SET total = $1 WHERE id = $2`, [round2(total), quotationId]);
  await emitEvent(client, ctx, { eventType: 'procurement.quotation_received', entityType: 'supplier_quotations', entityId: quotationId, entityCode: quoteNo, payload: { total: round2(total) } });
  return { quotationId, quoteNo, total: round2(total) };
}

/** Evaluate quotations for an RFQ; select the best and award the RFQ. */
export async function evaluateQuotations(client: pg.PoolClient, ctx: Ctx, rfqId: number) {
  const quotes = await client.query(
    `SELECT sq.id, sq.supplier_id, sq.total, sq.quote_no,
            COALESCE(AVG(sqi.lead_time_days), 999) AS avg_lead
     FROM supplier_quotations sq
     LEFT JOIN supplier_quotation_items sqi ON sqi.quotation_id = sq.id
     WHERE sq.rfq_id = $1 AND sq.status = 'RECEIVED'
     GROUP BY sq.id, sq.supplier_id, sq.total, sq.quote_no
     ORDER BY sq.total ASC, avg_lead ASC`,
    [rfqId]
  );
  if (quotes.rows.length === 0) throw badRequest('No received quotations to evaluate');
  const selected = quotes.rows[0];
  for (const q of quotes.rows) {
    await client.query(
      `UPDATE supplier_quotations SET status = $1 WHERE id = $2`,
      [Number(q.id) === Number(selected.id) ? 'SELECTED' : 'REJECTED', q.id]
    );
  }
  await client.query(`UPDATE rfqs SET status = 'AWARDED' WHERE id = $1`, [rfqId]);
  await emitEvent(client, ctx, {
    eventType: 'procurement.rfq_awarded',
    entityType: 'rfqs',
    entityId: rfqId,
    payload: { selectedQuote: selected.quote_no, supplierId: Number(selected.supplier_id) },
  });
  return { rfqId, selectedQuoteId: Number(selected.id), supplierId: Number(selected.supplier_id) };
}

/** Create a purchase order (DRAFT). Caller submits to start the workflow. */
export async function createPurchaseOrder(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    supplierId: number;
    requisitionId?: number | null;
    supplierQuotationId?: number | null;
    orderDate?: string;
    expectedDate?: string | null;
    currency?: string;
    notes?: string | null;
    securityClassification?: string;
    items: { productId: number; quantity: number; unitPrice: number; taxPercent?: number; expectedDate?: string | null; needBy?: string | null }[];
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  const poNo = await nextDoc(client, ctx, 'PO');
  let subtotal = 0;
  let tax = 0;
  for (const item of input.items) {
    const lineTotal = Number(item.quantity) * Number(item.unitPrice);
    subtotal += lineTotal;
    tax += lineTotal * (Number(item.taxPercent ?? 0) / 100);
  }
  const total = round2(subtotal + tax);
  const ins = await client.query(
    `INSERT INTO purchase_orders
       (company_id, tenant_id, branch_id, po_no, supplier_id, supplier_quotation_id, requisition_id,
        order_date, expected_date, currency, status, subtotal, tax_amount, total, security_classification, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, poNo, input.supplierId,
      input.supplierQuotationId ?? null, input.requisitionId ?? null,
      input.orderDate ?? new Date().toISOString().slice(0, 10), input.expectedDate ?? null,
      input.currency ?? 'UGX', round2(subtotal), round2(tax), total,
      input.securityClassification ?? 'NONE', input.notes ?? null, ctx.userId ?? null,
    ]
  );
  const orderId = Number(ins.rows[0].id);
  for (const item of input.items) {
    const lineTotal = Number(item.quantity) * Number(item.unitPrice);
    const taxAmt = lineTotal * (Number(item.taxPercent ?? 0) / 100);
    await client.query(
      `INSERT INTO purchase_order_items
         (order_id, product_id, quantity, unit_price, tax_percent, line_total, expected_date, need_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId, item.productId, item.quantity, item.unitPrice, Number(item.taxPercent ?? 0), round2(lineTotal + taxAmt), item.expectedDate ?? null, item.needBy ?? null]
    );
    await client.query(
      `INSERT INTO supplier_price_history (tenant_id, company_id, supplier_id, product_id, unit_price, currency, effective_date, source, source_id, source_no, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PO',$8,$9,$10)
       ON CONFLICT (source, source_id, product_id) DO NOTHING`,
      [ctx.tenantId, ctx.companyId, input.supplierId, item.productId, item.unitPrice, input.currency ?? 'UGX', input.orderDate ?? new Date().toISOString().slice(0, 10), orderId, poNo, ctx.userId ?? null]
    );
  }
  await emitEvent(client, ctx, { eventType: 'procurement.po_created', entityType: 'purchase_orders', entityId: orderId, entityCode: poNo, payload: { total } });
  return { orderId, poNo, total };
}

export async function submitPurchaseOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `UPDATE purchase_orders SET status = 'SUBMITTED' WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING po_no, total`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Purchase order not found or not DRAFT');
  await startWorkflow(client, ctx, {
    entityType: 'procurement.orders',
    entityId: orderId,
    entityCode: String(res.rows[0].po_no),
    amount: Number(res.rows[0].total),
  });
  return { orderId, poNo: String(res.rows[0].po_no) };
}

/** Goods receipt: receive PO lines into stock (creates batches, posts inventory + finance). */
export async function createGoodsReceipt(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    poId: number;
    receivedAt?: string;
    deliveryRef?: string | null;
    notes?: string | null;
    items: { poItemId: number; productId: number; quantityReceived: number; unitCost?: number; expiryDate?: string | null; batchNo?: string | null }[];
  }
) {
  const po = await client.query(
    `SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND status IN ('APPROVED','PARTIALLY_RECEIVED')`,
    [input.poId, ctx.tenantId]
  );
  if (po.rows.length === 0) throw badRequest('Purchase order not found or not receivable');
  const poRow = po.rows[0];
  const grnNo = await nextDoc(client, ctx, 'GRN');
  const ins = await client.query(
    `INSERT INTO goods_receipts
       (company_id, tenant_id, branch_id, grn_no, po_id, supplier_id, received_at, received_by, delivery_ref, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED',$10) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, grnNo, input.poId, Number(poRow.supplier_id),
      input.receivedAt ?? new Date().toISOString(), ctx.userId ?? 0, input.deliveryRef ?? null, input.notes ?? null,
    ]
  );
  const grnId = Number(ins.rows[0].id);

  for (const item of input.items) {
    const product = await productMeta(client, ctx, item.productId);
    const poItem = await client.query(
      `SELECT * FROM purchase_order_items WHERE id = $1 AND order_id = $2`,
      [item.poItemId, input.poId]
    );
    if (poItem.rows.length === 0) throw badRequest(`PO line ${item.poItemId} not found`);
    if (Number(item.quantityReceived) <= 0) throw badRequest('Received quantity must be positive');
    const unitCost = Number(item.unitCost ?? poItem.rows[0].unit_price ?? 0);

    // Create / reuse a product batch
    let batchId: number | null = null;
    if (item.batchNo) {
      const existing = await client.query(
        `SELECT id FROM product_batches WHERE company_id = $1 AND product_id = $2 AND batch_no = $3`,
        [ctx.companyId, item.productId, item.batchNo]
      );
      batchId = existing.rows.length ? Number(existing.rows[0].id) : null;
    }
    if (!batchId) {
      const batchNo = item.batchNo ?? await nextDoc(client, ctx, 'BT');
      const bres = await client.query(
        `INSERT INTO product_batches (company_id, tenant_id, product_id, supplier_id, batch_no, received_at, expiry_date, quantity, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          ctx.companyId, ctx.tenantId, item.productId, Number(poRow.supplier_id), batchNo,
          input.receivedAt ?? new Date().toISOString(), item.expiryDate ?? null, 0, unitCost,
        ]
      );
      batchId = Number(bres.rows[0].id);
    }

    const warehouseId = await warehouseByType(client, ctx, String(product.type));
    const binId = await defaultBin(client, ctx, warehouseId);
    await client.query(
      `INSERT INTO goods_receipt_items
         (grn_id, po_item_id, product_id, quantity_received, unit_cost, batch_id, batch_no, expiry_date, qc_status, warehouse_id, bin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10)`,
      [
        grnId, item.poItemId, item.productId, item.quantityReceived, unitCost, batchId,
        item.batchNo ?? null, item.expiryDate ?? null, warehouseId, binId,
      ]
    );

    await postMove(client, ctx, {
      movementType: 'RECEIPT',
      product: item.productId,
      batch: batchId,
      warehouse: warehouseId,
      bin: binId,
      quantity: Number(item.quantityReceived),
      unitCost,
      refType: 'goods_receipts',
      refId: grnId,
      refCode: grnNo,
      reason: `GRN ${grnNo}`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: item.productId,
      productType: String(product.type),
      amount: Number(item.quantityReceived) * unitCost,
      entryDate: (input.receivedAt ?? new Date().toISOString()).slice(0, 10),
      description: `Goods receipt ${grnNo}`,
      journalType: 'GOODS_RECEIPT',
      refType: 'goods_receipts',
      refId: grnId,
      refCode: grnNo,
      contraAccountCode: '2210', // GR/IR accrual, cleared on supplier invoice
    });
    await client.query(
      `UPDATE purchase_order_items SET received_qty = received_qty + $1 WHERE id = $2`,
      [item.quantityReceived, item.poItemId]
    );
  }

  const totals = await client.query(
    `SELECT COALESCE(SUM(received_qty), 0)::numeric AS received, COALESCE(SUM(quantity), 0)::numeric AS ordered
     FROM purchase_order_items WHERE order_id = $1`,
    [input.poId]
  );
  const poStatus = Number(totals.rows[0].received) >= Number(totals.rows[0].ordered) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  await client.query(`UPDATE purchase_orders SET status = $1 WHERE id = $2`, [poStatus, input.poId]);
  await emitEvent(client, ctx, { eventType: 'procurement.goods_received', entityType: 'goods_receipts', entityId: grnId, entityCode: grnNo });
  await logAudit(client, ctx, { action: 'receive', resource: 'goods_receipts', recordId: grnId, recordCode: grnNo, newValues: { poId: input.poId } });
  return { grnId, grnNo };
}

/** QC a goods receipt; pass/fail/quarantine lines. */
export async function qcGoodsReceipt(
  client: pg.PoolClient,
  ctx: Ctx,
  grnId: number,
  input: { results: { grnItemId: number; result: 'PASSED' | 'FAILED' | 'QUARANTINED'; notes?: string | null; parameters?: { parameter: string; actual_value: string; standard_value?: string; passed?: boolean }[] }[] }
) {
  const grn = await client.query(
    `SELECT * FROM goods_receipts WHERE id = $1 AND tenant_id = $2 AND status = 'RECEIVED'`,
    [grnId, ctx.tenantId]
  );
  if (grn.rows.length === 0) throw badRequest('Goods receipt not found or not in RECEIVED status');
  const grnRow = grn.rows[0];
  const qItems = await client.query(`SELECT * FROM goods_receipt_items WHERE grn_id = $1`, [grnId]);
  const byId = new Map<number, any>();
  for (const r of qItems.rows) byId.set(Number(r.id), r);

  const quarantineWh = await client.query(
    `SELECT id FROM warehouses WHERE company_id = $1 AND code = 'QUARANTINE'`,
    [ctx.companyId]
  );

  let passedCount = 0;
  let failedCount = 0;
  const inspections: number[] = [];

  for (const r of input.results) {
    const item = byId.get(r.grnItemId);
    if (!item) throw badRequest(`GRN item ${r.grnItemId} not found`);
    const inspectionNo = await nextDoc(client, ctx, 'INS');
    const insp = await client.query(
      `INSERT INTO inspections
         (company_id, tenant_id, inspection_no, kind, ref_type, ref_id, product_id, batch_id, quantity, sampled_qty,
          result, status, inspector_id, inspected_at, completed_at, approved_by, approved_at, notes)
       VALUES ($1,$2,$3,'INCOMING','goods_receipts',$4,$5,$6,$7,$8,$9,'APPROVED',$10,now(),now(),$10,now(),$11) RETURNING id`,
      [
        ctx.companyId, ctx.tenantId, inspectionNo, grnId, item.product_id, item.batch_id ?? null,
        item.quantity_received, item.quantity_received, r.result, ctx.userId ?? null, r.notes ?? null,
      ]
    );
    const inspectionId = Number(insp.rows[0].id);
    inspections.push(inspectionId);
    for (const p of r.parameters ?? []) {
      await client.query(
        `INSERT INTO inspection_results (inspection_id, parameter, standard_value, actual_value, passed, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [inspectionId, p.parameter, p.standard_value ?? null, p.actual_value, p.passed ?? (r.result === 'PASSED'), null]
      );
    }

    const product = await productMeta(client, ctx, Number(item.product_id));
    const warehouseId = Number(item.warehouse_id);
    if (r.result === 'FAILED' || r.result === 'QUARANTINED') {
      // Move to quarantine / reject
      const target = quarantineWh.rows.length ? Number(quarantineWh.rows[0].id) : null;
      if (target) {
        await postMove(client, ctx, {
          movementType: 'TRANSFER_OUT',
          product: Number(item.product_id),
          batch: item.batch_id ? Number(item.batch_id) : null,
          fromWarehouse: warehouseId,
          toWarehouse: target,
          quantity: Number(item.quantity_received),
          unitCost: Number(item.unit_cost) || 0,
          refType: 'goods_receipts',
          refId: grnId,
          refCode: String(grnRow.grn_no),
          reason: `QC ${r.result} ${grnRow.grn_no}`,
        });
      }
      failedCount += 1;
      await client.query(
        `UPDATE goods_receipt_items SET quantity_accepted = 0, quantity_rejected = $1, qc_status = $2, qc_inspection_id = $3 WHERE id = $4`,
        [item.quantity_received, r.result === 'QUARANTINED' ? 'QUARANTINED' : 'FAILED', inspectionId, r.grnItemId]
      );
    } else {
      passedCount += 1;
      await client.query(
        `UPDATE goods_receipt_items SET quantity_accepted = quantity_received, quantity_rejected = 0, qc_status = 'PASSED', qc_inspection_id = $1 WHERE id = $2`,
        [inspectionId, r.grnItemId]
      );
    }
  }

  const totalItems = qItems.rows.length;
  let grnStatus = 'APPROVED';
  if (failedCount === totalItems) grnStatus = 'REJECTED';
  else if (failedCount > 0) grnStatus = 'PARTIALLY_APPROVED';
  await client.query(`UPDATE goods_receipts SET status = $1 WHERE id = $2`, [grnStatus, grnId]);
  await emitEvent(client, ctx, {
    eventType: 'quality.inspection_completed',
    entityType: 'goods_receipts',
    entityId: grnId,
    entityCode: String(grnRow.grn_no),
    payload: { status: grnStatus, inspections },
  });
  await logAudit(client, ctx, { action: 'qc', resource: 'goods_receipts', recordId: grnId, recordCode: String(grnRow.grn_no), newValues: { status: grnStatus } });
  return { grnId, status: grnStatus, inspections };
}

function normDocNo(value: unknown): string | null {
  const t = String(value ?? '').trim();
  return t ? t : null;
}

async function assertNoDuplicateSupplierInvoice(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { supplierId: number; supplierDocumentNo: string | null; poId: number; total: number; invoiceDate: string }
) {
  if (input.supplierDocumentNo) {
    const dup = await client.query(
      `SELECT supplier_invoice_no FROM supplier_invoices
       WHERE company_id = $1 AND supplier_id = $2 AND status <> 'VOID'
         AND lower(btrim(supplier_document_no)) = lower(btrim($3))
       LIMIT 1`,
      [ctx.companyId, input.supplierId, input.supplierDocumentNo]
    );
    if (dup.rows.length) {
      throw conflict(
        `Duplicate supplier invoice: document ${input.supplierDocumentNo} already exists as ${dup.rows[0].supplier_invoice_no}`
      );
    }
  }
  const same = await client.query(
    `SELECT supplier_invoice_no FROM supplier_invoices
     WHERE company_id = $1 AND supplier_id = $2 AND po_id = $3 AND status <> 'VOID'
       AND invoice_date = $4::date AND total = $5
       AND COALESCE(lower(btrim(supplier_document_no)),'') = COALESCE(lower(btrim($6)),'')
     LIMIT 1`,
    [ctx.companyId, input.supplierId, input.poId, input.invoiceDate, input.total, input.supplierDocumentNo]
  );
  if (same.rows.length) {
    throw conflict(
      `Duplicate supplier invoice: ${same.rows[0].supplier_invoice_no} already records this PO, date and amount`
    );
  }
}

async function assertNoDuplicateSupplierPayment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { supplierId: number; amount: number; paymentDate: string; reference: string | null; supplierInvoiceId: number | null }
) {
  const params: unknown[] = [ctx.companyId, input.supplierId, input.paymentDate, input.amount];
  let sql = `SELECT payment_no FROM supplier_payments
     WHERE company_id = $1 AND supplier_id = $2 AND status <> 'VOID'
       AND payment_date = $3::date AND amount = $4`;
  if (input.reference) {
    params.push(input.reference);
    sql += ` AND lower(btrim(COALESCE(reference,''))) = lower(btrim($5))`;
  } else if (input.supplierInvoiceId) {
    params.push(input.supplierInvoiceId);
    sql += ` AND supplier_invoice_id = $5 AND (reference IS NULL OR btrim(reference) = '')`;
  } else {
    sql += ` AND (reference IS NULL OR btrim(reference) = '') AND supplier_invoice_id IS NULL`;
  }
  sql += ' LIMIT 1';
  const dup = await client.query(sql, params);
  if (dup.rows.length) {
    throw conflict(`Duplicate supplier payment: ${dup.rows[0].payment_no} already records this amount on ${input.paymentDate}`);
  }
}

/** Supplier invoice with three-way matching validation; workflow posts on approval. */
export async function createSupplierInvoice(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    poId: number;
    grnId?: number | null;
    supplierId: number;
    invoiceDate?: string;
    dueDate?: string | null;
    notes?: string | null;
    supplierDocumentNo?: string | null;
    items: { poItemId: number; productId: number; quantity: number; unitPrice: number; taxPercent?: number }[];
  }
) {
  const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2`, [input.poId, ctx.tenantId]);
  if (po.rows.length === 0) throw badRequest('Purchase order not found');
  const poRow = po.rows[0];

  let subtotal = 0;
  let tax = 0;
  let allMatch = true;
  for (const item of input.items) {
    const poItem = await client.query(
      `SELECT * FROM purchase_order_items WHERE id = $1 AND order_id = $2`,
      [item.poItemId, input.poId]
    );
    if (poItem.rows.length === 0) throw badRequest(`PO line ${item.poItemId} not found`);
    const poLine = poItem.rows[0];
    const qty = Number(item.quantity);
    const price = Number(item.unitPrice);
    const received = await client.query(
      `SELECT COALESCE(SUM(quantity_received), 0)::numeric AS qty
       FROM goods_receipt_items gri
       JOIN goods_receipts gr ON gr.id = gri.grn_id
       WHERE gri.po_item_id = $1 AND gr.tenant_id = $2 AND gr.status NOT IN ('REJECTED')`,
      [item.poItemId, ctx.tenantId]
    );
    // Three-way match: invoice qty ≤ received (and remaining PO qty), price matches PO
    if (qty > Number(poLine.quantity) - Number(poLine.invoiced_qty)) allMatch = false;
    if (qty > Number(received.rows[0].qty)) allMatch = false;
    if (Math.abs(price - Number(poLine.unit_price)) > 0.01) allMatch = false;
    subtotal += qty * price;
    tax += qty * price * (Number(item.taxPercent ?? 0) / 100);
  }
  const total = round2(subtotal + tax);
  const invoiceDate = input.invoiceDate ?? new Date().toISOString().slice(0, 10);
  const supplierDocumentNo = normDocNo(input.supplierDocumentNo);
  await assertNoDuplicateSupplierInvoice(client, ctx, {
    supplierId: input.supplierId,
    supplierDocumentNo,
    poId: input.poId,
    total,
    invoiceDate,
  });

  const invoiceNo = await nextDoc(client, ctx, 'SI');
  const ins = await client.query(
    `INSERT INTO supplier_invoices
       (company_id, tenant_id, branch_id, supplier_invoice_no, po_id, grn_id, supplier_id, invoice_date, due_date,
        status, subtotal, tax_amount, total, three_way_matched, notes, supplier_document_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, invoiceNo, input.poId, input.grnId ?? null, input.supplierId,
      invoiceDate, input.dueDate ?? null,
      round2(subtotal), round2(tax), total, allMatch, input.notes ?? null, supplierDocumentNo,
    ]
  );
  const invoiceId = Number(ins.rows[0].id);
  for (const item of input.items) {
    const lineTotal = Number(item.quantity) * Number(item.unitPrice);
    const taxAmt = lineTotal * (Number(item.taxPercent ?? 0) / 100);
    await client.query(
      `INSERT INTO supplier_invoice_items (invoice_id, po_item_id, product_id, quantity, unit_price, tax_percent, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invoiceId, item.poItemId, item.productId, item.quantity, item.unitPrice, Number(item.taxPercent ?? 0), round2(lineTotal + taxAmt)]
    );
    await client.query(`UPDATE purchase_order_items SET invoiced_qty = invoiced_qty + $1 WHERE id = $2`, [item.quantity, item.poItemId]);
  }
  if (allMatch) {
    await client.query(`UPDATE purchase_orders SET three_way_matched = true WHERE id = $1`, [input.poId]);
  }
  await emitEvent(client, ctx, { eventType: 'procurement.supplier_invoice_created', entityType: 'supplier_invoices', entityId: invoiceId, entityCode: invoiceNo, payload: { total } });
  return { invoiceId, invoiceNo, total, threeWayMatched: allMatch };
}

export async function submitSupplierInvoice(client: pg.PoolClient, ctx: Ctx, invoiceId: number) {
  const res = await client.query(
    `UPDATE supplier_invoices SET status = 'SUBMITTED' WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING supplier_invoice_no, total`,
    [invoiceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Supplier invoice not found or not DRAFT');
  await startWorkflow(client, ctx, {
    entityType: 'procurement.supplier_invoices',
    entityId: invoiceId,
    entityCode: String(res.rows[0].supplier_invoice_no),
    amount: Number(res.rows[0].total),
  });
  return { invoiceId, supplierInvoiceNo: String(res.rows[0].supplier_invoice_no) };
}

/** Supplier payment; workflow releases and auto-posts the bank/AP journal. */
export async function createSupplierPayment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { supplierInvoiceId?: number | null; supplierId: number; paymentDate?: string; amount: number; method?: string; reference?: string | null; bankAccountId?: number | null }
) {
  const amount = Number(input.amount);
  if (!(amount > 0)) throw badRequest('Payment amount must be positive');
  const paymentDate = input.paymentDate ?? new Date().toISOString().slice(0, 10);
  const reference = input.reference != null ? String(input.reference).trim() || null : null;
  await assertNoDuplicateSupplierPayment(client, ctx, {
    supplierId: input.supplierId,
    amount,
    paymentDate,
    reference,
    supplierInvoiceId: input.supplierInvoiceId ?? null,
  });
  const paymentNo = await nextDoc(client, ctx, 'SP');
  const ins = await client.query(
    `INSERT INTO supplier_payments
       (company_id, tenant_id, payment_no, supplier_invoice_id, supplier_id, payment_date, amount, method, reference, bank_account_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, paymentNo, input.supplierInvoiceId ?? null,
      input.supplierId, paymentDate, amount,
      input.method ?? 'BANK_TRANSFER', reference, input.bankAccountId ?? null,
    ]
  );
  const paymentId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'procurement.payment_created', entityType: 'supplier_payments', entityId: paymentId, entityCode: paymentNo, payload: { amount: Number(input.amount) } });
  return { paymentId, paymentNo };
}

export async function submitSupplierPayment(client: pg.PoolClient, ctx: Ctx, paymentId: number) {
  const res = await client.query(
    `UPDATE supplier_payments SET status = 'SUBMITTED' WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING payment_no, amount`,
    [paymentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Supplier payment not found or not PENDING');
  await startWorkflow(client, ctx, {
    entityType: 'procurement.payments',
    entityId: paymentId,
    entityCode: String(res.rows[0].payment_no),
    amount: Number(res.rows[0].amount),
  });
  return { paymentId, paymentNo: String(res.rows[0].payment_no) };
}

// ---------------------------------------------------------------------------
// Converts, approvals, returns
// ---------------------------------------------------------------------------

/** Raise a DRAFT purchase order from an approved requisition. */
export async function convertRequisition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { requisitionId: number; supplierId: number; expectedDate?: string | null; notes?: string | null }
) {
  const pr = await client.query(
    `SELECT * FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw notFound('Requisition not found');
  if (!['APPROVED', 'PARTIALLY_ORDERED'].includes(String(pr.rows[0].status))) {
    throw badRequest(`Requisition must be APPROVED (current: ${pr.rows[0].status})`);
  }
  const items = await client.query(
    `SELECT * FROM purchase_requisition_items WHERE requisition_id = $1 AND quantity > ordered_qty`,
    [input.requisitionId]
  );
  if (items.rows.length === 0) throw badRequest('Nothing left to order on this requisition');
  const po = await createPurchaseOrder(client, ctx, {
    supplierId: input.supplierId,
    requisitionId: input.requisitionId,
    expectedDate: input.expectedDate ?? pr.rows[0].required_date ?? null,
    notes: input.notes ?? `From ${pr.rows[0].pr_no}`,
    items: items.rows.map((it) => ({
      productId: Number(it.product_id),
      quantity: Number(it.quantity) - Number(it.ordered_qty),
      unitPrice: Number(it.estimated_cost) || 0,
    })),
  });
  for (const it of items.rows) {
    await client.query(
      `UPDATE purchase_requisition_items SET ordered_qty = quantity WHERE id = $1`,
      [it.id]
    );
  }
  // Derive the lifecycle state: fully converted once nothing remains to order.
  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM purchase_requisition_items WHERE requisition_id = $1 AND quantity > ordered_qty`,
    [input.requisitionId]
  );
  const nextStatus = Number(remaining.rows[0].n) === 0 ? 'FULLY_CONVERTED' : 'PARTIALLY_CONVERTED';
  await client.query(
    `UPDATE purchase_requisitions SET status = $1, converted_by = $2, converted_at = now() WHERE id = $3`,
    [nextStatus, ctx.userId ?? null, input.requisitionId]
  );
  await recordPrTransition(client, ctx, {
    requisitionId: input.requisitionId,
    from: String(pr.rows[0].status),
    to: nextStatus,
    comment: `Converted to ${po.poNo}`,
    prNo: String(pr.rows[0].pr_no),
  });
  return po;
}

/** Raise a DRAFT PO from the awarded quotation on an RFQ. */
export async function convertAwardedRfq(client: pg.PoolClient, ctx: Ctx, rfqId: number) {
  const rfq = await client.query(`SELECT * FROM rfqs WHERE id = $1 AND tenant_id = $2`, [rfqId, ctx.tenantId]);
  if (rfq.rows.length === 0) throw notFound('RFQ not found');
  if (String(rfq.rows[0].status) !== 'AWARDED') throw badRequest(`RFQ must be AWARDED (current: ${rfq.rows[0].status})`);
  const quote = await client.query(
    `SELECT * FROM supplier_quotations WHERE rfq_id = $1 AND status = 'SELECTED' ORDER BY id DESC LIMIT 1`,
    [rfqId]
  );
  if (quote.rows.length === 0) throw badRequest('No selected quotation on this RFQ');
  const q = quote.rows[0];
  const qItems = await client.query(`SELECT * FROM supplier_quotation_items WHERE quotation_id = $1`, [q.id]);
  return createPurchaseOrder(client, ctx, {
    supplierId: Number(q.supplier_id),
    supplierQuotationId: Number(q.id),
    requisitionId: rfq.rows[0].requisition_id != null ? Number(rfq.rows[0].requisition_id) : undefined,
    notes: `Awarded from ${rfq.rows[0].rfq_no}`,
    items: qItems.rows.map((it) => ({
      productId: Number(it.product_id),
      quantity: Number(it.quantity),
      unitPrice: Number(it.unit_price),
    })),
  });
}

export async function approvePurchaseOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Purchase order not found');
  const po = res.rows[0];
  if (!['DRAFT', 'SUBMITTED'].includes(String(po.status))) {
    throw badRequest(`Purchase order cannot be approved from ${po.status}`);
  }
  await client.query(
    `UPDATE purchase_orders SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`,
    [orderId, ctx.userId ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'procurement.po_approved',
    entityType: 'purchase_orders',
    entityId: orderId,
    entityCode: String(po.po_no),
  });
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'purchase_orders',
    recordId: orderId,
    recordCode: String(po.po_no),
    newValues: { status: 'APPROVED' },
  });
  return { orderId, poNo: po.po_no, status: 'APPROVED' };
}

export async function cancelPurchaseOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `UPDATE purchase_orders SET status = 'CANCELLED'
     WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED')
       AND NOT EXISTS (SELECT 1 FROM purchase_order_items i WHERE i.order_id = $1 AND i.received_qty > 0)
     RETURNING po_no`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Purchase order cannot be cancelled (received lines or wrong status)');
  return { orderId, poNo: res.rows[0].po_no, status: 'CANCELLED' };
}

// ── Purchase Order Amendments ───────────────────────────────────────────────
// Approved purchase orders are frozen commercial documents. Amendments are the
// controlled, re-approvable path for quantity/price deltas and additional
// lines. Each amendment re-runs the standard workflow engine
// (entity: procurement.po_amendments) and is applied as a single audited
// transaction; the PO is never mutated while any line has been received.

interface AmendmentLineInput {
  poItemId?: number | null;
  productId?: number | null;
  newQty?: number | null;
  newUnitPrice?: number | null;
  newLineQty?: number | null;
  newLineUnitPrice?: number | null;
  taxPercent?: number | null;
}

/** Draft a PO amendment (delta lines against an approved order). */
export async function createPurchaseOrderAmendment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { orderId: number; reason?: string | null; items: AmendmentLineInput[] }
) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw badRequest('Amendment requires at least one line change');
  }
  const poRes = await client.query(
    `SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.orderId, ctx.tenantId]
  );
  const po = poRes.rows[0];
  if (!po) throw notFound('Purchase order not found');
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(String(po.status))) {
    throw badRequest(`Purchase order cannot be amended in status ${po.status}`);
  }
  const itemRes = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = $1 ORDER BY i.id`,
    [input.orderId]
  );
  const poItems = itemRes.rows;
  if (poItems.some((i) => Number(i.received_qty) > 0)) {
    throw badRequest('Purchase order cannot be amended: lines have already been received');
  }
  const openRes = await client.query(
    `SELECT 1 FROM po_amendments WHERE order_id = $1 AND status IN ('DRAFT','SUBMITTED') LIMIT 1`,
    [input.orderId]
  );
  if (openRes.rows.length > 0) throw badRequest('An amendment is already pending for this purchase order');

  const byId = new Map(poItems.map((i) => [Number(i.id), i]));
  let subtotal = 0;
  let tax = 0;
  const changes: {
    poItemId: number | null;
    productId: number;
    changeType: string;
    prevQty: number | null;
    prevUnitPrice: number | null;
    newQty: number | null;
    newUnitPrice: number | null;
    newLineQty: number | null;
    newLineUnitPrice: number | null;
    taxPercent: number;
  }[] = [];
  for (const raw of input.items) {
    if (raw.poItemId != null) {
      const prev = byId.get(Number(raw.poItemId));
      if (!prev) throw badRequest('Amendment line references an item that is not on this purchase order');
      const prevQty = Number(prev.quantity);
      const prevPrice = Number(prev.unit_price);
      const newQty = raw.newQty != null ? Number(raw.newQty) : prevQty;
      const newPrice = raw.newUnitPrice != null ? Number(raw.newUnitPrice) : prevPrice;
      if (!Number.isFinite(newQty) || newQty <= 0) throw badRequest('New quantity must be positive');
      if (!Number.isFinite(newPrice) || newPrice < 0) throw badRequest('New unit price must be zero or positive');
      const changeType =
        newQty !== prevQty && newPrice !== prevPrice ? 'QTY_PRICE' : newQty !== prevQty ? 'QTY' : newPrice !== prevPrice ? 'PRICE' : null;
      if (!changeType) throw badRequest('No change for amendment line (quantity and unit price unchanged)');
      const taxPercent = Number(prev.tax_percent);
      const deltaSubtotal = (newQty - prevQty) * newPrice + (newPrice - prevPrice) * prevQty;
      subtotal += deltaSubtotal;
      tax += deltaSubtotal * (taxPercent / 100);
      changes.push({
        poItemId: Number(prev.id),
        productId: Number(prev.product_id),
        changeType,
        prevQty,
        prevUnitPrice: prevPrice,
        newQty,
        newUnitPrice: newPrice,
        newLineQty: null,
        newLineUnitPrice: null,
        taxPercent,
      });
    } else {
      if (raw.productId == null) throw badRequest('New amendment lines require a product');
      const newQty = Number(raw.newLineQty);
      const newPrice = Number(raw.newLineUnitPrice);
      if (!Number.isFinite(newQty) || newQty <= 0) throw badRequest('New line quantity must be positive');
      if (!Number.isFinite(newPrice) || newPrice < 0) throw badRequest('New line unit price must be zero or positive');
      const taxPercent = Number(raw.taxPercent ?? 0);
      const deltaSubtotal = newQty * newPrice;
      subtotal += deltaSubtotal;
      tax += deltaSubtotal * (taxPercent / 100);
      changes.push({
        poItemId: null,
        productId: Number(raw.productId),
        changeType: 'NEW_LINE',
        prevQty: null,
        prevUnitPrice: null,
        newQty: null,
        newUnitPrice: null,
        newLineQty: newQty,
        newLineUnitPrice: newPrice,
        taxPercent,
      });
    }
  }
  const amendmentTotal = round2(subtotal + tax);
  const amendmentNo = await nextDoc(client, ctx, 'AM');
  const ins = await client.query(
    `INSERT INTO po_amendments
       (company_id, tenant_id, branch_id, order_id, amendment_no, reason, status, subtotal, tax_amount, total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9,$10) RETURNING id`,
    [
      po.company_id, ctx.tenantId, po.branch_id ?? ctx.branchId ?? null, input.orderId, amendmentNo,
      input.reason ?? null, round2(subtotal), round2(tax), amendmentTotal, ctx.userId ?? null,
    ]
  );
  const amendmentId = Number(ins.rows[0].id);
  for (const ch of changes) {
    await client.query(
      `INSERT INTO po_amendment_items
         (amendment_id, po_item_id, product_id, change_type, prev_qty, prev_unit_price, new_qty, new_unit_price,
          new_line_qty, new_line_unit_price, tax_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        amendmentId, ch.poItemId, ch.productId, ch.changeType, ch.prevQty, ch.prevUnitPrice,
        ch.newQty, ch.newUnitPrice, ch.newLineQty, ch.newLineUnitPrice, ch.taxPercent,
      ]
    );
  }
  await logAudit(client, ctx, {
    action: 'amend_draft',
    resource: 'po_amendments',
    recordId: amendmentId,
    recordCode: amendmentNo,
    metadata: { orderId: input.orderId, poNo: po.po_no, changeCount: changes.length, total: amendmentTotal },
  });
  return { amendmentId, amendmentNo, total: amendmentTotal, status: 'DRAFT' };
}

/** Submit a drafted amendment into the standard approval workflow. */
export async function submitPurchaseOrderAmendment(client: pg.PoolClient, ctx: Ctx, amendmentId: number) {
  const res = await client.query(
    `UPDATE po_amendments SET status = 'SUBMITTED'
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
     RETURNING amendment_no, total, company_id`,
    [amendmentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Amendment not found or not DRAFT');
  const row = res.rows[0];
  const workflowInstanceId = await startWorkflow(client, ctx, {
    entityType: 'procurement.po_amendments',
    entityId: amendmentId,
    entityCode: String(row.amendment_no),
    amount: Math.abs(Number(row.total)),
    companyId: Number(row.company_id),
  });
  if (workflowInstanceId != null) {
    await client.query(`UPDATE po_amendments SET workflow_instance_id = $1 WHERE id = $2`, [workflowInstanceId, amendmentId]);
  }
  await logAudit(client, ctx, {
    action: 'submit',
    resource: 'po_amendments',
    recordId: amendmentId,
    recordCode: String(row.amendment_no),
    newValues: { status: 'SUBMITTED', total: Number(row.total) },
  });
  return { amendmentId, amendmentNo: String(row.amendment_no), status: 'SUBMITTED', workflowInstanceId };
}

/** Apply an approved amendment atomically: mutate lines, recompute totals, audit. */
export async function applyPurchaseOrderAmendment(client: pg.PoolClient, ctx: Ctx, amendmentId: number) {
  const amRes = await client.query(
    `SELECT * FROM po_amendments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [amendmentId, ctx.tenantId]
  );
  const am = amRes.rows[0];
  if (!am) throw notFound('Purchase order amendment not found');
  if (String(am.status) === 'APPLIED') throw badRequest('Amendment has already been applied');
  if (String(am.status) !== 'APPROVED') throw badRequest(`Amendment cannot be applied in status ${am.status}`);
  const poRes = await client.query(
    `SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [am.order_id, ctx.tenantId]
  );
  const po = poRes.rows[0];
  if (!po) throw notFound('Purchase order not found');
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(String(po.status))) {
    throw badRequest(`Purchase order cannot be amended in status ${po.status}`);
  }
  const openRes = await client.query(
    `SELECT 1 FROM po_amendments WHERE order_id = $1 AND id <> $2 AND status IN ('DRAFT','SUBMITTED') LIMIT 1`,
    [am.order_id, amendmentId]
  );
  if (openRes.rows.length > 0) throw badRequest('Another amendment is pending for this purchase order');
  const receivedRes = await client.query(
    `SELECT 1 FROM purchase_order_items WHERE order_id = $1 AND received_qty > 0 LIMIT 1`,
    [am.order_id]
  );
  if (receivedRes.rows.length > 0) throw badRequest('Purchase order cannot be amended: lines have already been received');
  const amItemsRes = await client.query(
    `SELECT * FROM po_amendment_items WHERE amendment_id = $1 ORDER BY id`,
    [amendmentId]
  );
  const amItems = amItemsRes.rows;
  if (amItems.length === 0) throw badRequest('Amendment has no line changes');
  for (const it of amItems) {
    if (String(it.change_type) === 'NEW_LINE') {
      const lineTotal = round2(Number(it.new_line_qty) * Number(it.new_line_unit_price) * (1 + Number(it.tax_percent) / 100));
      await client.query(
        `INSERT INTO purchase_order_items (order_id, product_id, quantity, unit_price, tax_percent, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [am.order_id, Number(it.product_id), it.new_line_qty, it.new_line_unit_price, it.tax_percent, lineTotal]
      );
    } else {
      if (it.po_item_id == null) throw badRequest('Amendment line is missing a purchase order item reference');
      const lineTotal = round2(Number(it.new_qty) * Number(it.new_unit_price) * (1 + Number(it.tax_percent) / 100));
      await client.query(
        `UPDATE purchase_order_items SET quantity = $1, unit_price = $2, line_total = $3
         WHERE id = $4 AND order_id = $5`,
        [it.new_qty, it.new_unit_price, lineTotal, Number(it.po_item_id), am.order_id]
      );
    }
  }
  const totals = await client.query(
    `SELECT COALESCE(SUM(quantity * unit_price), 0) AS subtotal,
            COALESCE(SUM(quantity * unit_price * tax_percent / 100), 0) AS tax
     FROM purchase_order_items WHERE order_id = $1`,
    [am.order_id]
  );
  const subtotal = round2(Number(totals.rows[0].subtotal));
  const tax = round2(Number(totals.rows[0].tax));
  const total = round2(subtotal + tax);
  await client.query(
    `UPDATE purchase_orders SET status = 'APPROVED', subtotal = $2, tax_amount = $3, total = $4 WHERE id = $1`,
    [am.order_id, subtotal, tax, total]
  );
  // Price intelligence: record the amended price as the authoritative PO price.
  for (const it of amItems) {
    const changedPrice = ['PRICE', 'QTY_PRICE', 'NEW_LINE'].includes(String(it.change_type));
    if (!changedPrice) continue;
    const newPrice = String(it.change_type) === 'NEW_LINE' ? Number(it.new_line_unit_price) : Number(it.new_unit_price);
    await client.query(
      `INSERT INTO supplier_price_history
         (tenant_id, company_id, supplier_id, product_id, unit_price, currency, effective_date, source, source_id, source_no, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PO',$8,$9,$10)
       ON CONFLICT (source, source_id, product_id) DO UPDATE
         SET unit_price = EXCLUDED.unit_price, effective_date = EXCLUDED.effective_date, created_by = EXCLUDED.created_by`,
      [
        ctx.tenantId, po.company_id, po.supplier_id, Number(it.product_id), newPrice, po.currency,
        new Date().toISOString().slice(0, 10), am.order_id, po.po_no, ctx.userId ?? null,
      ]
    );
  }
  await client.query(
    `UPDATE po_amendments SET status = 'APPLIED', decided_by = $2, decided_at = now() WHERE id = $1`,
    [amendmentId, ctx.userId ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'procurement.po_amended',
    entityType: 'purchase_orders',
    entityId: Number(am.order_id),
    entityCode: String(po.po_no),
    payload: { amendmentNo: am.amendment_no, total, lines: amItems.length },
  });
  await logAudit(client, ctx, {
    action: 'amend',
    resource: 'purchase_orders',
    recordId: Number(am.order_id),
    recordCode: String(po.po_no),
    oldValues: { subtotal: Number(po.subtotal), taxAmount: Number(po.tax_amount), total: Number(po.total) },
    newValues: { subtotal, taxAmount: tax, total, amendmentNo: am.amendment_no },
    metadata: { amendmentId: Number(am.id) },
  });
  return {
    amendmentId,
    amendmentNo: String(am.amendment_no),
    orderId: Number(am.order_id),
    poNo: String(po.po_no),
    total,
    status: 'APPLIED',
  };
}

/** List amendments for a purchase order with their line changes. */
export async function listPurchaseOrderAmendments(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `SELECT a.*,
            TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name,
            TRIM(BOTH FROM COALESCE(d.first_name,'') || ' ' || COALESCE(d.last_name,'')) AS decided_by_name
     FROM po_amendments a
     LEFT JOIN users u ON u.id = a.created_by
     LEFT JOIN users d ON d.id = a.decided_by
     WHERE a.order_id = $1 AND a.tenant_id = $2
     ORDER BY a.id DESC`,
    [orderId, ctx.tenantId]
  );
  const amendments = [];
  for (const row of res.rows) {
    const items = await client.query(
      `SELECT i.*, p.code AS product_code, p.name AS product_name
       FROM po_amendment_items i JOIN products p ON p.id = i.product_id
       WHERE i.amendment_id = $1 ORDER BY i.id`,
      [row.id]
    );
    amendments.push({ ...toCamelRow(row), items: toCamelRows(items.rows) });
  }
  return { amendments };
}

export async function createPurchaseReturn(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    grnId: number;
    reason: string;
    items: { productId: number; quantity: number; batchId?: number | null }[];
  }
) {
  if (!input.items?.length) throw badRequest('Return at least one line');
  const grn = await client.query(`SELECT * FROM goods_receipts WHERE id = $1 AND tenant_id = $2`, [input.grnId, ctx.tenantId]);
  if (grn.rows.length === 0) throw notFound('Goods receipt not found');
  const grnRow = grn.rows[0];
  const returnNo = await nextDoc(client, ctx, 'PRN');
  const ins = await client.query(
    `INSERT INTO purchase_returns
       (company_id, tenant_id, return_no, grn_id, po_id, supplier_id, return_date, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, returnNo, input.grnId, grnRow.po_id, grnRow.supplier_id,
      new Date().toISOString().slice(0, 10), input.reason,
    ]
  );
  const returnId = Number(ins.rows[0].id);
  for (const item of input.items) {
    if (Number(item.quantity) <= 0) throw badRequest('Return quantity must be positive');
    const product = await productMeta(client, ctx, item.productId);
    const warehouseId = await warehouseByType(client, ctx, String(product.type));
    await client.query(
      `INSERT INTO purchase_return_items (return_id, product_id, quantity, batch_id, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [returnId, item.productId, item.quantity, item.batchId ?? null, input.reason]
    );
    await postMove(client, ctx, {
      movementType: 'ISSUE',
      product: item.productId,
      batch: item.batchId ?? null,
      warehouse: warehouseId,
      quantity: Number(item.quantity),
      unitCost: Number(product.standard_cost) || 0,
      refType: 'purchase_returns',
      refId: returnId,
      refCode: returnNo,
      reason: `Return ${returnNo}`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: item.productId,
      productType: String(product.type),
      amount: -(Number(item.quantity) * (Number(product.standard_cost) || 0)),
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Purchase return ${returnNo}`,
      journalType: 'PURCHASE_RETURN',
      refType: 'purchase_returns',
      refId: returnId,
      refCode: returnNo,
      contraAccountCode: '2210',
    });
  }
  await emitEvent(client, ctx, {
    eventType: 'procurement.return_created',
    entityType: 'purchase_returns',
    entityId: returnId,
    entityCode: returnNo,
  });
  return { returnId, returnNo };
}

export async function makeFromDemand(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; quantity: number; supplierId?: number | null; needBy?: string | null; notes?: string | null }
) {
  if (!(Number(input.quantity) > 0)) throw badRequest('Quantity must be positive');
  return createRequisition(client, ctx, {
    requiredDate: input.needBy ?? null,
    notes: input.notes ?? 'Raised from buy demand',
    items: [{
      productId: input.productId,
      quantity: Number(input.quantity),
      suggestedSupplierId: input.supplierId ?? null,
      needBy: input.needBy ?? null,
    }],
  });
}

// ---------------------------------------------------------------------------
// Lists + desks
// ---------------------------------------------------------------------------

export async function listSuppliers(client: pg.PoolClient, ctx: Ctx, filters: { q?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['s.tenant_id = $1', 's.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(s.code ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT s.id, s.code, s.name, s.supplier_type, s.status, s.phone, s.email, s.payment_terms_days, s.security_cleared
     FROM suppliers s WHERE ${where.join(' AND ')} ORDER BY s.name LIMIT 200`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listRequisitions(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['pr.tenant_id = $1', 'pr.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`pr.pr_no ILIKE $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`pr.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT pr.id, pr.pr_no, pr.status,
            TO_CHAR(pr.requested_date, 'YYYY-MM-DD') AS requested_date,
            TO_CHAR(pr.required_date, 'YYYY-MM-DD') AS required_date,
            pr.notes,
            pr.title, pr.category, pr.urgency, pr.currency_code, pr.total_estimated, pr.base_total,
            pr.budget_check_status, pr.budget_variance,
            u.username AS requested_by_name,
            w.name AS warehouse_name, cc.code AS cost_centre_code,
            (SELECT count(*) FROM purchase_requisition_items i WHERE i.requisition_id = pr.id)::int AS item_count,
            (SELECT COALESCE(sum(i.quantity * i.estimated_cost),0) FROM purchase_requisition_items i WHERE i.requisition_id = pr.id)::numeric AS estimated_total
     FROM purchase_requisitions pr
     LEFT JOIN users u ON u.id = pr.requested_by
     LEFT JOIN warehouses w ON w.id = pr.warehouse_id
     LEFT JOIN cost_centres cc ON cc.id = pr.cost_centre_id
     WHERE ${where.join(' AND ')}
     ORDER BY pr.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function getRequisition(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT pr.*, u.username AS requested_by_name,
            po.username AS procurement_officer_name,
            d.code AS department_code, d.name AS department_name,
            w.code AS warehouse_code, w.name AS warehouse_name,
            cc.code AS cost_centre_code, cc.name AS cost_centre_name,
            a.code AS account_code, a.name AS account_name,
            cu.username AS cancelled_by_name, cv.username AS converted_by_name,
            c.code AS company_code, c.name AS company_name,
            b.code AS branch_code, b.name AS branch_name,
            fy.code AS fiscal_year_code, fy.name AS fiscal_year_name,
            cur.name AS currency_name, cur.symbol AS currency_symbol,
            tx.name AS tax_name, tx.tax_type AS tax_type,
            TO_CHAR(pr.requested_date, 'YYYY-MM-DD') AS requested_date,
            TO_CHAR(pr.required_date, 'YYYY-MM-DD') AS required_date
     FROM purchase_requisitions pr
     LEFT JOIN companies c ON c.id = pr.company_id
     LEFT JOIN branches b ON b.id = pr.branch_id
     LEFT JOIN fiscal_years fy ON fy.id = pr.fiscal_year_id
     LEFT JOIN currencies cur ON cur.code = pr.currency_code
     LEFT JOIN taxes tx ON tx.company_id = pr.company_id AND tx.code = pr.tax_code
     LEFT JOIN users u ON u.id = pr.requested_by
     LEFT JOIN departments d ON d.id = pr.department_id
     LEFT JOIN warehouses w ON w.id = pr.warehouse_id
     LEFT JOIN cost_centres cc ON cc.id = pr.cost_centre_id
     LEFT JOIN chart_of_accounts a ON a.id = pr.account_id
     LEFT JOIN users cu ON cu.id = pr.cancelled_by
     LEFT JOIN users cv ON cv.id = pr.converted_by
     LEFT JOIN users po ON po.id = pr.procurement_officer_id
     WHERE pr.id = $1 AND pr.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Requisition not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name,
            u.code AS unit_code, u.name AS unit_name,
            s.code AS supplier_code, s.name AS suggested_supplier,
            ga.code AS gl_account_code, ga.name AS gl_account_name,
            TO_CHAR(i.need_by, 'YYYY-MM-DD') AS need_by
     FROM purchase_requisition_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN units u ON u.id = i.unit_id
     LEFT JOIN suppliers s ON s.id = i.suggested_supplier_id
     LEFT JOIN chart_of_accounts ga ON ga.id = i.gl_account_id
     WHERE i.requisition_id = $1 ORDER BY i.id`,
    [id]
  );
  const orders = await client.query(
    `SELECT id, po_no, status, total FROM purchase_orders WHERE requisition_id = $1 ORDER BY id`,
    [id]
  );
  const wfRes = await client.query(
    `SELECT i.id AS instance_id, i.status AS instance_status, i.current_step, i.submitted_at, i.completed_at,
            w.code AS workflow_code, w.name AS workflow_name
     FROM workflow_instances i
     LEFT JOIN workflows w ON w.id = i.workflow_id
     WHERE i.tenant_id = $1 AND i.entity_type = 'procurement.requisitions' AND i.entity_id = $2
     ORDER BY i.id DESC LIMIT 1`,
    [ctx.tenantId, id]
  );
  let workflow: Record<string, unknown> | null = null;
  if (wfRes.rows.length) {
    const tasks = await client.query(
      `SELECT t.id, t.step_seq, t.step_name, t.status, t.comment, t.decided_by, t.decided_at, t.due_at,
              r.code AS approver_role, u.username AS assignee_name, du.username AS decided_by_name
       FROM approval_tasks t
       LEFT JOIN roles r ON r.id = t.approver_role_id
       LEFT JOIN users u ON u.id = t.approver_user_id
       LEFT JOIN users du ON du.id = t.decided_by
       WHERE t.instance_id = $1 ORDER BY t.step_seq`,
      [Number(wfRes.rows[0].instance_id)]
    );
    workflow = { instance: toCamelRow(wfRes.rows[0]), tasks: toCamelRows(tasks.rows) };
  }
  const [comments, history, assignments, attachments] = await Promise.all([
    client.query(
      `SELECT c.id, c.body, c.is_internal, c.mentions, c.created_at,
              u.username, u.first_name, u.last_name
       FROM pr_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.requisition_id = $1
       ORDER BY c.id DESC LIMIT 200`,
      [id]
    ),
    client.query(
      `SELECT h.id, h.from_status, h.to_status, h.comment, h.created_at,
              u.username, u.first_name, u.last_name
       FROM pr_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.requisition_id = $1
       ORDER BY h.id`,
      [id]
    ),
    client.query(
      `SELECT a.id, a.officer_user_id, a.assigned_at, a.notes,
              u.username, u.first_name, u.last_name
       FROM pr_assignments a
       LEFT JOIN users u ON u.id = a.officer_user_id
       WHERE a.requisition_id = $1
       ORDER BY a.id DESC`,
      [id]
    ),
    client.query(
      `SELECT a.id, a.file_name, a.file_path, a.mime_type, a.size_bytes, a.classification, a.created_at,
              u.username, u.first_name, u.last_name
       FROM pr_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.requisition_id = $1
       ORDER BY a.id DESC LIMIT 100`,
      [id]
    ),
  ]);
  const remainingBudget = await budgetRemaining(client, ctx, res.rows[0]);
  const rfqs = await client.query(
    `SELECT id, rfq_no, status, issue_date, closing_date FROM rfqs WHERE requisition_id = $1 ORDER BY id`,
    [id]
  );
  return {
    requisition: toCamelRow(res.rows[0]),
    items: toCamelRows(items.rows),
    orders: toCamelRows(orders.rows),
    rfqs: toCamelRows(rfqs.rows),
    workflow,
    comments: toCamelRows(comments.rows),
    history: toCamelRows(history.rows),
    assignments: toCamelRows(assignments.rows),
    attachments: toCamelRows(attachments.rows),
    remainingBudget,
  };
}

export async function listRfqs(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT r.id, r.rfq_no, r.status, r.issue_date, r.closing_date, r.notes,
            r.requisition_id, pr.pr_no,
            (SELECT count(*) FROM rfq_items i WHERE i.rfq_id = r.id)::int AS item_count,
            (SELECT count(*) FROM supplier_quotations q WHERE q.rfq_id = r.id)::int AS quote_count
     FROM rfqs r
     LEFT JOIN purchase_requisitions pr ON pr.id = r.requisition_id
     WHERE r.tenant_id = $1 AND r.company_id = $2 ORDER BY r.id DESC LIMIT 100`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getRfq(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(`SELECT * FROM rfqs WHERE id = $1 AND tenant_id = $2`, [id, ctx.tenantId]);
  if (res.rows.length === 0) throw notFound('RFQ not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM rfq_items i JOIN products p ON p.id = i.product_id WHERE i.rfq_id = $1 ORDER BY i.id`,
    [id]
  );
  const suppliers = await client.query(
    `SELECT rs.supplier_id, s.code, s.name FROM rfq_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id WHERE rs.rfq_id = $1`,
    [id]
  );
  let requisition: Record<string, unknown> | null = null;
  if (res.rows[0].requisition_id != null) {
    const prRes = await client.query(
      `SELECT pr.id, pr.pr_no, pr.status, pr.title, pr.currency_code,
              u.username AS requested_by_name,
              d.code AS department_code, d.name AS department_name,
              TO_CHAR(pr.requested_date, 'YYYY-MM-DD') AS requested_date,
              TO_CHAR(pr.required_date, 'YYYY-MM-DD') AS required_date
       FROM purchase_requisitions pr
       LEFT JOIN users u ON u.id = pr.requested_by
       LEFT JOIN departments d ON d.id = pr.department_id
       WHERE pr.id = $1 AND pr.tenant_id = $2`,
      [res.rows[0].requisition_id, ctx.tenantId]
    );
    if (prRes.rows.length) requisition = toCamelRow(prRes.rows[0]);
  }
  const quotes = await client.query(
    `SELECT q.id, q.quote_no, q.status, q.total, q.quote_date, q.valid_until, q.supplier_id,
            s.code AS supplier_code, s.name AS supplier_name
     FROM supplier_quotations q JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.rfq_id = $1 ORDER BY q.total ASC`,
    [id]
  );
  const quotationIds = quotes.rows.map((q) => Number(q.id));
  const quoteItems: Record<number, Record<string, unknown>[]> = {};
  if (quotationIds.length) {
    const qi = await client.query(
      `SELECT qi.quotation_id, qi.rfq_item_id, qi.product_id, qi.quantity, qi.unit_price,
              qi.lead_time_days, qi.line_total, p.code AS product_code, p.name AS product_name
       FROM supplier_quotation_items qi JOIN products p ON p.id = qi.product_id
       WHERE qi.quotation_id = ANY($1) ORDER BY qi.id`,
      [quotationIds]
    );
    for (const row of qi.rows) {
      const qid = Number(row.quotation_id);
      (quoteItems[qid] ??= []).push(toCamelRow(row));
    }
  }
  const productIds = items.rows.map((i) => Number(i.product_id));
  let priceHistory: Record<string, unknown>[] = [];
  if (productIds.length) {
    const ph = await client.query(
      `WITH paid AS (
         SELECT poi.product_id, poi.unit_price, po.po_no, po.order_date
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE poi.product_id = ANY($1) AND po.status NOT IN ('CANCELLED','DRAFT')
       ),
       prior AS (
         SELECT sqi.product_id, sqi.unit_price, sq.quote_no, sq.quote_date
         FROM supplier_quotation_items sqi
         JOIN supplier_quotations sq ON sq.id = sqi.quotation_id
         WHERE sqi.product_id = ANY($1) AND sq.status IN ('RECEIVED','SELECTED')
       )
       SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
              (SELECT count(*) FROM paid WHERE product_id = p.id)::int AS order_count,
              (SELECT round(avg(unit_price), 2) FROM paid WHERE product_id = p.id) AS avg_paid,
              (SELECT unit_price FROM paid WHERE product_id = p.id ORDER BY order_date DESC, po_no DESC LIMIT 1) AS last_paid,
              (SELECT TO_CHAR(order_date, 'YYYY-MM-DD') FROM paid WHERE product_id = p.id ORDER BY order_date DESC, po_no DESC LIMIT 1) AS last_paid_on,
              (SELECT count(*) FROM prior WHERE product_id = p.id)::int AS prior_quote_count,
              (SELECT round(avg(unit_price), 2) FROM prior WHERE product_id = p.id) AS avg_prior_quote
       FROM products p WHERE p.id = ANY($1) ORDER BY p.code`,
      [productIds]
    );
    priceHistory = toCamelRows(ph.rows);
  }
  return {
    rfq: toCamelRow(res.rows[0]),
    requisition,
    items: toCamelRows(items.rows),
    suppliers: toCamelRows(suppliers.rows),
    quotations: quotes.rows.map((q) => ({
      ...toCamelRow(q),
      items: quoteItems[Number(q.id)] ?? [],
    })),
    priceHistory,
  };
}

export async function listOrders(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['po.tenant_id = $1', 'po.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(po.po_no ILIKE $${params.length} OR s.name ILIKE $${params.length} OR s.code ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`po.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT po.id, po.po_no, po.status, po.order_date, po.expected_date, po.total, po.tax_amount, po.three_way_matched,
            s.code AS supplier_code, s.name AS supplier_name,
            (SELECT COALESCE(sum(i.received_qty),0) FROM purchase_order_items i WHERE i.order_id = po.id)::numeric AS received_qty,
            (SELECT COALESCE(sum(i.quantity),0) FROM purchase_order_items i WHERE i.order_id = po.id)::numeric AS ordered_qty
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY po.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function getOrderDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT po.*, s.code AS supplier_code, s.name AS supplier_name, s.payment_terms_days,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn, s.website AS supplier_website,
            pr.pr_no, sq.quote_no
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     LEFT JOIN supplier_quotations sq ON sq.id = po.supplier_quotation_id
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Purchase order not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, p.type AS product_type
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = $1 ORDER BY i.id`,
    [id]
  );
  const receipts = await client.query(
    `SELECT id, grn_no, status, received_at, delivery_ref FROM goods_receipts WHERE po_id = $1 ORDER BY id`,
    [id]
  );
  const invoices = await client.query(
    `SELECT id, supplier_invoice_no, status, total, three_way_matched, invoice_date, amount_paid
     FROM supplier_invoices WHERE po_id = $1 ORDER BY id`,
    [id]
  );
  const lastPrices = await client.query(
    `SELECT DISTINCT ON (product_id) product_id, unit_price, effective_date, source, source_no
     FROM supplier_price_history
     WHERE tenant_id = $1 AND supplier_id = $2 AND product_id = ANY($3::bigint[])
     ORDER BY product_id, effective_date DESC, id DESC`,
    [ctx.tenantId, res.rows[0].supplier_id, items.rows.map((i) => i.product_id)]
  );
  const lastPriceByProduct = new Map<number, { unitPrice: number; effectiveDate: unknown; source: string; sourceNo: unknown }>();
  for (const r of lastPrices.rows) {
    lastPriceByProduct.set(Number(r.product_id), {
      unitPrice: Number(r.unit_price),
      effectiveDate: r.effective_date,
      source: r.source,
      sourceNo: r.source_no,
    });
  }
  const match = items.rows.map((it) => ({
    poItemId: Number(it.id),
    productCode: it.product_code,
    orderedQty: Number(it.quantity),
    receivedQty: Number(it.received_qty),
    invoicedQty: Number(it.invoiced_qty),
    unitPrice: Number(it.unit_price),
    matched: Number(it.received_qty) > 0 && Number(it.invoiced_qty) > 0 && Number(it.invoiced_qty) <= Number(it.received_qty),
  }));
  const itemsOut = toCamelRows(items.rows).map((it) => {
    const last = lastPriceByProduct.get(Number(it.productId));
    return {
      ...it,
      lastUnitPrice: last ? last.unitPrice : null,
      lastPriceDate: last ? last.effectiveDate : null,
      lastPriceSource: last ? last.source : null,
      lastPriceSourceNo: last ? last.sourceNo : null,
    };
  });
  return {
    order: toCamelRow(res.rows[0]),
    items: itemsOut,
    receipts: toCamelRows(receipts.rows),
    invoices: toCamelRows(invoices.rows),
    match,
  };
}

/** Price-trend profile for a single history row (consistent with three-way match variance). */
function priceProfile(prev: number | null, changePct: number): string {
  if (prev == null) return 'NEW';
  if (changePct < -5) return 'LOW';
  if (changePct < 0) return 'NEGATIVE';
  if (changePct > 15) return 'ABOVE';
  if (changePct > 0) return 'POSITIVE';
  return 'FLAT';
}

/** Supplier price history with per-line prior-price delta (price intelligence). */
export async function listPriceHistory(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; supplierId?: number; productId?: number; days?: number; flag?: string; page?: number; pageSize?: number } = {}
) {
  const days = Math.max(7, Math.min(filters.days ?? 365, 1095));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 40)));
  const flag = ['LOW', 'NEGATIVE', 'POSITIVE', 'ABOVE', 'NEW', 'FLAT'].includes(String(filters.flag ?? '').toUpperCase())
    ? String(filters.flag).toUpperCase()
    : null;
  const where = ['sph.tenant_id = $1', 'sph.effective_date >= (CURRENT_DATE - ($2)::int)'];
  const params: unknown[] = [ctx.tenantId, days];
  const push = (cond: string, ...values: unknown[]) => {
    for (const v of values) {
      params.push(v);
      cond = cond.replace('?', `$${params.length}`);
    }
    where.push(cond);
  };
  if (filters.supplierId != null && Number.isFinite(filters.supplierId)) push('sph.supplier_id = ?', filters.supplierId);
  if (filters.productId != null && Number.isFinite(filters.productId)) push('sph.product_id = ?', filters.productId);
  const q = filters.q?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    push('(LOWER(s.code) LIKE ? OR LOWER(s.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(p.name) LIKE ?)', like, like, like, like);
  }
  const flagCond =
    flag == null
      ? 'TRUE'
      : flag === 'LOW'
        ? 'c.change_pct < -5'
        : flag === 'NEGATIVE'
          ? 'c.change_pct >= -5 AND c.change_pct < 0'
          : flag === 'POSITIVE'
            ? 'c.change_pct > 0 AND c.change_pct <= 15'
            : flag === 'ABOVE'
              ? 'c.change_pct > 15'
              : flag === 'NEW'
                ? 'c.prev_unit_price IS NULL'
                : 'c.change_pct = 0 AND c.prev_unit_price IS NOT NULL';
  const cte = `WITH windowed AS (
       SELECT sph.id, sph.supplier_id, sph.product_id, sph.unit_price, sph.currency,
              sph.effective_date, sph.source, sph.source_id, sph.source_no, sph.created_at,
              s.code AS supplier_code, s.name AS supplier_name,
              p.code AS product_code, p.name AS product_name,
              LAG(sph.unit_price) OVER (
                PARTITION BY sph.supplier_id, sph.product_id
                ORDER BY sph.effective_date, sph.id
              ) AS prev_unit_price
       FROM supplier_price_history sph
       JOIN suppliers s ON s.id = sph.supplier_id
       JOIN products p ON p.id = sph.product_id
       WHERE ${where.join(' AND ')}
     ),
     computed AS (
       SELECT w.*,
              ROUND(CASE WHEN w.prev_unit_price IS NULL THEN 0
                         ELSE ((w.unit_price - w.prev_unit_price) / w.prev_unit_price) * 100
                    END, 2)::float8 AS change_pct
       FROM windowed w
     ),
     flagged AS (
       SELECT c.*, COUNT(*) OVER () AS total_count
       FROM computed c
       WHERE ${flagCond}
     )`;
  const res = await client.query(
    `${cte}
     SELECT f.* FROM flagged f
     ORDER BY f.effective_date DESC, f.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  const summary = await client.query(
    `${cte}
     SELECT COUNT(*)::int AS total,
            COALESCE(MIN(f.unit_price)::float8, 0) AS cheapest,
            COALESCE(ROUND(AVG(f.unit_price)::numeric, 2)::float8, 0) AS avg_price,
            COALESCE(MAX(f.unit_price)::float8, 0) AS max_price,
            COALESCE(SUM(CASE WHEN f.prev_unit_price IS NULL THEN 1 ELSE 0 END)::int, 0) AS new_count,
            COALESCE(SUM(CASE WHEN f.change_pct < -5 THEN 1 ELSE 0 END)::int, 0) AS low_count,
            COALESCE(SUM(CASE WHEN f.change_pct >= -5 AND f.change_pct < 0 THEN 1 ELSE 0 END)::int, 0) AS negative_count,
            COALESCE(SUM(CASE WHEN f.change_pct > 0 AND f.change_pct <= 15 THEN 1 ELSE 0 END)::int, 0) AS positive_count,
            COALESCE(SUM(CASE WHEN f.change_pct > 15 THEN 1 ELSE 0 END)::int, 0) AS above_count,
            COALESCE(SUM(CASE WHEN f.change_pct = 0 AND f.prev_unit_price IS NOT NULL THEN 1 ELSE 0 END)::int, 0) AS flat_count
     FROM flagged f`,
    params
  );
  const rows = res.rows.map((r) => {
    const prev = r.prev_unit_price != null ? Number(r.prev_unit_price) : null;
    const changePct = Number(r.change_pct);
    return {
      id: Number(r.id),
      supplierId: Number(r.supplier_id),
      supplierCode: r.supplier_code,
      supplierName: r.supplier_name,
      productId: Number(r.product_id),
      productCode: r.product_code,
      productName: r.product_name,
      unitPrice: Number(r.unit_price),
      prevUnitPrice: prev,
      changePct,
      profile: priceProfile(prev, changePct),
      currency: r.currency,
      effectiveDate: r.effective_date,
      source: r.source,
      sourceNo: r.source_no,
      createdAt: r.created_at,
    };
  });
  const s = summary.rows[0];
  return {
    rows,
    page,
    pageSize,
    total: Number(res.rows[0]?.total_count ?? 0),
    summary: {
      total: Number(s?.total ?? 0),
      cheapest: Number(s?.cheapest ?? 0),
      avgPrice: Number(s?.avg_price ?? 0),
      maxPrice: Number(s?.max_price ?? 0),
      counts: {
        NEW: Number(s?.new_count ?? 0),
        LOW: Number(s?.low_count ?? 0),
        NEGATIVE: Number(s?.negative_count ?? 0),
        POSITIVE: Number(s?.positive_count ?? 0),
        ABOVE: Number(s?.above_count ?? 0),
        FLAT: Number(s?.flat_count ?? 0),
      },
    },
  };
}

export async function listGoodsReceipts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT g.id, g.grn_no, g.status, g.received_at, g.delivery_ref,
            po.po_no, s.code AS supplier_code, s.name AS supplier_name,
            (SELECT count(*) FROM goods_receipt_items i WHERE i.grn_id = g.id)::int AS item_count
     FROM goods_receipts g
     JOIN purchase_orders po ON po.id = g.po_id
     JOIN suppliers s ON s.id = g.supplier_id
     WHERE g.tenant_id = $1 AND g.company_id = $2
     ORDER BY g.id DESC LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getGoodsReceipt(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT g.*, po.po_no, s.code AS supplier_code, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn
     FROM goods_receipts g
     JOIN purchase_orders po ON po.id = g.po_id
     JOIN suppliers s ON s.id = g.supplier_id
     WHERE g.id = $1 AND g.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Goods receipt not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM goods_receipt_items i JOIN products p ON p.id = i.product_id
     WHERE i.grn_id = $1 ORDER BY i.id`,
    [id]
  );
  const [inspections, invoices, returns] = await Promise.all([
    client.query(
      `SELECT id, inspection_no, kind, result, status, inspected_at
       FROM inspections WHERE ref_type = 'goods_receipts' AND ref_id = $1 ORDER BY id`,
      [id]
    ),
    client.query(
      `SELECT id, supplier_invoice_no, status, total, invoice_date
       FROM supplier_invoices WHERE grn_id = $1 ORDER BY id`,
      [id]
    ),
    client.query(
      `SELECT id, return_no, status, reason, return_date FROM purchase_returns WHERE grn_id = $1 ORDER BY id`,
      [id]
    ),
  ]);
  return {
    receipt: toCamelRow(res.rows[0]),
    items: toCamelRows(items.rows),
    inspections: toCamelRows(inspections.rows),
    invoices: toCamelRows(invoices.rows),
    returns: toCamelRows(returns.rows),
  };
}

export async function listSupplierInvoices(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['si.tenant_id = $1', 'si.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(si.supplier_invoice_no ILIKE $${params.length} OR si.supplier_document_no ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`si.status = $${params.length}`);
  }
  const res = await client.query(
    `SELECT si.id, si.supplier_invoice_no, si.supplier_document_no, si.status, si.invoice_date, si.due_date, si.total, si.amount_paid,
            si.three_way_matched, si.gl_posted, po.po_no, s.code AS supplier_code, s.name AS supplier_name
     FROM supplier_invoices si
     JOIN suppliers s ON s.id = si.supplier_id
     LEFT JOIN purchase_orders po ON po.id = si.po_id
     WHERE ${where.join(' AND ')}
     ORDER BY si.id DESC LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function getSupplierInvoice(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT si.*, po.po_no, g.grn_no, s.code AS supplier_code, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn, s.payment_terms_days
     FROM supplier_invoices si
     JOIN suppliers s ON s.id = si.supplier_id
     LEFT JOIN purchase_orders po ON po.id = si.po_id
     LEFT JOIN goods_receipts g ON g.id = si.grn_id
     WHERE si.id = $1 AND si.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Supplier invoice not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM supplier_invoice_items i JOIN products p ON p.id = i.product_id
     WHERE i.invoice_id = $1 ORDER BY i.id`,
    [id]
  );
  const payments = await client.query(
    `SELECT id, payment_no, status, amount, payment_date FROM supplier_payments WHERE supplier_invoice_id = $1 ORDER BY id`,
    [id]
  );
  return { invoice: toCamelRow(res.rows[0]), items: toCamelRows(items.rows), payments: toCamelRows(payments.rows) };
}

export async function listPayments(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT p.id, p.payment_no, p.status, p.amount, p.payment_date, p.method, p.reference, p.gl_posted,
            s.code AS supplier_code, s.name AS supplier_name, si.supplier_invoice_no
     FROM supplier_payments p
     JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN supplier_invoices si ON si.id = p.supplier_invoice_id
     WHERE p.tenant_id = $1 AND p.company_id = $2
     ORDER BY p.id DESC LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getSupplierPayment(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT p.*, s.code AS supplier_code, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn,
            si.supplier_invoice_no, si.total AS invoice_total, si.amount_paid AS invoice_amount_paid,
            po.po_no, b.bank_name, b.name AS bank_account_name, b.account_no AS bank_account_no, b.code AS bank_account_code
     FROM supplier_payments p
     JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN supplier_invoices si ON si.id = p.supplier_invoice_id
     LEFT JOIN purchase_orders po ON po.id = si.po_id
     LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Supplier payment not found');
  return { payment: toCamelRow(res.rows[0]) };
}

export async function getPurchaseReturn(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT r.*, s.code AS supplier_code, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn,
            g.grn_no, po.po_no
     FROM purchase_returns r
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN goods_receipts g ON g.id = r.grn_id
     LEFT JOIN purchase_orders po ON po.id = r.po_id
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Purchase return not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, b.batch_no
     FROM purchase_return_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN product_batches b ON b.id = i.batch_id
     WHERE i.return_id = $1 ORDER BY i.id`,
    [id]
  );
  return { purchaseReturn: toCamelRow(res.rows[0]), items: toCamelRows(items.rows) };
}

export async function getSupplierQuotation(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT q.*, s.code AS supplier_code, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email,
            s.tin AS supplier_tin, s.vrn AS supplier_vrn,
            r.rfq_no, pr.pr_no
     FROM supplier_quotations q
     JOIN suppliers s ON s.id = q.supplier_id
     LEFT JOIN rfqs r ON r.id = q.rfq_id
     LEFT JOIN purchase_requisitions pr ON pr.id = r.requisition_id
     WHERE q.id = $1 AND q.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Supplier quotation not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM supplier_quotation_items i JOIN products p ON p.id = i.product_id
     WHERE i.quotation_id = $1 ORDER BY i.id`,
    [id]
  );
  return { quotation: toCamelRow(res.rows[0]), items: toCamelRows(items.rows) };
}

export async function getInspection(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, b.batch_no,
            u.username AS inspector_name
     FROM inspections i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN product_batches b ON b.id = i.batch_id
     LEFT JOIN users u ON u.id = i.inspector_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Inspection not found');
  const results = await client.query(
    `SELECT * FROM inspection_results WHERE inspection_id = $1 ORDER BY id`,
    [id]
  );
  return { inspection: toCamelRow(res.rows[0]), results: toCamelRows(results.rows) };
}

export async function buyBoard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM purchase_requisitions WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED'))::int AS open_prs,
       (SELECT count(*) FROM purchase_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED'))::int AS awaiting,
       (SELECT count(*) FROM purchase_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','PARTIALLY_RECEIVED'))::int AS open_pos,
       (SELECT COALESCE(sum(total),0) FROM purchase_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','PARTIALLY_RECEIVED','RECEIVED'))::numeric AS committed,
       (SELECT count(*) FROM supplier_invoices WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED','MATCHED','PARTIALLY_PAID') AND three_way_matched = false)::int AS unmatched,
       (SELECT COALESCE(sum(total - amount_paid),0) FROM supplier_invoices WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','PAID'))::numeric AS open_ap`,
    [ctx.tenantId, ctx.companyId]
  );
  const inbound = await client.query(
    `SELECT po.id, po.po_no, po.status, po.expected_date, s.name AS supplier_name,
            COALESCE(sum(poi.quantity - poi.received_qty),0)::numeric AS remaining_qty
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN purchase_order_items poi ON poi.order_id = po.id
     WHERE po.tenant_id = $1 AND po.company_id = $2
       AND po.status IN ('APPROVED','PARTIALLY_RECEIVED')
       AND poi.quantity > poi.received_qty
     GROUP BY po.id, po.po_no, po.status, po.expected_date, s.name
     ORDER BY po.expected_date NULLS LAST, po.id DESC
     LIMIT 20`,
    [ctx.tenantId, ctx.companyId]
  );
  const awaiting = await client.query(
    `SELECT po.id, po.po_no, po.status, po.total, po.order_date, s.name AS supplier_name
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.tenant_id = $1 AND po.company_id = $2 AND po.status IN ('DRAFT','SUBMITTED')
     ORDER BY po.id DESC LIMIT 15`,
    [ctx.tenantId, ctx.companyId]
  );
  const invoices = await client.query(
    `SELECT si.id, si.supplier_invoice_no, si.status, si.total, si.three_way_matched, si.due_date, s.name AS supplier_name
     FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
     WHERE si.tenant_id = $1 AND si.company_id = $2 AND si.status IN ('DRAFT','SUBMITTED','APPROVED','MATCHED','PARTIALLY_PAID')
     ORDER BY si.due_date NULLS LAST, si.id DESC LIMIT 15`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    kpis: toCamelRow(kpis.rows[0]),
    inbound: toCamelRows(inbound.rows),
    awaiting: toCamelRows(awaiting.rows),
    invoices: toCamelRows(invoices.rows),
  };
}

/** Plant shortages + latest MRP purchase suggestions + open PR remainder. */
export async function buyDemand(client: pg.PoolClient, ctx: Ctx) {
  const shortages = await client.query(
    `SELECT p.id AS product_id, p.code, p.name, p.type,
            sum(wm.required_qty - wm.issued_qty)::numeric AS short_qty,
            COALESCE((SELECT sum(i.quantity - i.reserved_qty) FROM inventory i WHERE i.product_id = wm.product_id),0)::numeric AS available
     FROM work_order_materials wm
     JOIN work_orders wo ON wo.id = wm.work_order_id
     JOIN products p ON p.id = wm.product_id
     WHERE wo.tenant_id = $1 AND wo.company_id = $2
       AND wo.status IN ('RELEASED','IN_PROGRESS','ON_HOLD','DRAFT','APPROVED')
       AND wm.required_qty > wm.issued_qty
     GROUP BY p.id, p.code, p.name, p.type, wm.product_id
     HAVING sum(wm.required_qty - wm.issued_qty) >
            COALESCE((SELECT sum(i.quantity - i.reserved_qty) FROM inventory i WHERE i.product_id = wm.product_id),0)
     ORDER BY 5 DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  const latestRun = await client.query(
    `SELECT id FROM mrp_runs WHERE tenant_id = $1 AND company_id = $2 AND status = 'COMPLETED' ORDER BY id DESC LIMIT 1`,
    [ctx.tenantId, ctx.companyId]
  );
  let mrp: Record<string, unknown>[] = [];
  if (latestRun.rows.length) {
    const req = await client.query(
      `SELECT p.id AS product_id, p.code, p.name, p.type, mr.suggested_quantity, mr.quantity AS net_qty
       FROM mrp_requirements mr
       JOIN products p ON p.id = mr.product_id
       WHERE mr.run_id = $1 AND mr.requirement_type = 'SUGGESTION' AND mr.suggestion_type = 'PURCHASE' AND mr.suggested_quantity > 0
       ORDER BY mr.suggested_quantity DESC`,
      [latestRun.rows[0].id]
    );
    mrp = toCamelRows(req.rows);
  }
  return { shortages: toCamelRows(shortages.rows), mrp };
}

// ---------------------------------------------------------------------------
// PR engine: hold/release, collaboration, documents, assignments, history
// ---------------------------------------------------------------------------

/** Hold a requisition (ON_HOLD). Approvers and procurement can freeze it. */
export async function holdRequisition(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  reason?: string | null
) {
  const res = await client.query(
    `SELECT pr_no, status FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [requisitionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Requisition not found');
  const pr = res.rows[0];
  assertPrTransition(String(pr.status), 'ON_HOLD');
  await client.query(
    `UPDATE purchase_requisitions SET status = 'ON_HOLD', held_reason = $1, hold_until = NULL WHERE id = $2`,
    [reason ?? null, requisitionId]
  );
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: String(pr.status),
    to: 'ON_HOLD',
    comment: reason ?? 'Placed on hold',
    prNo: String(pr.pr_no),
  });
  return { requisitionId, prNo: String(pr.pr_no), status: 'ON_HOLD' };
}

/** Release a held requisition, resuming at the natural point in its lifecycle. */
export async function releaseRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `SELECT pr_no, status FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [requisitionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Requisition not found');
  const pr = res.rows[0];
  if (String(pr.status) !== 'ON_HOLD') throw badRequest('Requisition is not on hold');
  const [po, wf] = await Promise.all([
    client.query(
      `SELECT count(*)::int AS n, COALESCE(sum((SELECT count(*) FROM purchase_requisition_items i WHERE i.requisition_id = po.requisition_id AND i.quantity > i.ordered_qty)),0)::int AS outstanding
       FROM purchase_orders po WHERE po.requisition_id = $1`,
      [requisitionId]
    ),
    client.query(
      `SELECT status FROM workflow_instances
       WHERE tenant_id = $1 AND entity_type = 'procurement.requisitions' AND entity_id = $2
       ORDER BY id DESC LIMIT 1`,
      [ctx.tenantId, requisitionId]
    ),
  ]);
  let resumeTo = 'SUBMITTED';
  if (Number(po.rows[0].n) > 0) {
    resumeTo = Number(po.rows[0].outstanding) === 0 ? 'FULLY_CONVERTED' : 'PARTIALLY_CONVERTED';
  } else if (wf.rows.length && String(wf.rows[0].status) === 'COMPLETED') {
    resumeTo = 'APPROVED';
  }
  assertPrTransition(String(pr.status), resumeTo);
  await client.query(
    `UPDATE purchase_requisitions SET status = $1, held_reason = NULL WHERE id = $2`,
    [resumeTo, requisitionId]
  );
  await recordPrTransition(client, ctx, {
    requisitionId,
    from: 'ON_HOLD',
    to: resumeTo,
    comment: 'Released from hold',
    prNo: String(pr.pr_no),
  });
  return { requisitionId, prNo: String(pr.pr_no), status: resumeTo };
}

/** Add a collaboration comment. @mentions notify the mentioned users. */
export async function commentOnRequisition(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  input: { body: string; isInternal?: boolean; mentions?: number[] }
) {
  const body = String(input.body ?? '').trim();
  if (!body) throw badRequest('Comment body is required');
  const pr = await client.query(
    `SELECT pr_no FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw notFound('Requisition not found');
  const mentions = Array.isArray(input.mentions)
    ? [...new Set(input.mentions.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];
  const ins = await client.query(
    `INSERT INTO pr_comments (requisition_id, user_id, body, is_internal, mentions)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [requisitionId, ctx.userId ?? 0, body, input.isInternal === true, JSON.stringify(mentions)]
  );
  await logAudit(client, ctx, {
    action: 'comment',
    resource: 'purchase_requisitions',
    recordId: requisitionId,
    recordCode: String(pr.rows[0].pr_no),
    newValues: { commentId: Number(ins.rows[0].id), isInternal: input.isInternal === true },
  });
  for (const uid of mentions) {
    if (uid === ctx.userId) continue;
    await notifyUserAdvanced(client, ctx, uid, {
      type: 'PR_COMMENT',
      title: `Mentioned on ${String(pr.rows[0].pr_no)}`,
      body: body.slice(0, 200),
      link: `/buy/requisitions/${requisitionId}`,
      entityType: 'purchase_requisitions',
      entityId: requisitionId,
      severity: 'INFO',
    });
  }
  return { commentId: Number(ins.rows[0].id) };
}

/** List collaboration comments on a requisition (newest first). */
export async function listPrComments(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  await client.query(
    `SELECT 1 FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  const res = await client.query(
    `SELECT c.id, c.body, c.is_internal, c.mentions, c.created_at,
            u.username, u.first_name, u.last_name
     FROM pr_comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.requisition_id = $1
     ORDER BY c.id DESC LIMIT 200`,
    [requisitionId]
  );
  return toCamelRows(res.rows);
}

/** Register a document against a requisition (metadata; bytes in object storage). */
export async function addPrAttachment(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  input: { fileName: string; filePath?: string | null; mimeType?: string | null; sizeBytes?: number; classification?: string }
) {
  const fileName = String(input.fileName ?? '').trim();
  if (!fileName) throw badRequest('file name is required');
  const pr = await client.query(
    `SELECT pr_no FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw notFound('Requisition not found');
  const ins = await client.query(
    `INSERT INTO pr_attachments
       (requisition_id, file_name, file_path, mime_type, size_bytes, classification, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      requisitionId,
      fileName,
      input.filePath ?? null,
      input.mimeType ?? null,
      Math.max(0, Number(input.sizeBytes ?? 0)),
      String(input.classification ?? 'INTERNAL'),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'attach',
    resource: 'purchase_requisitions',
    recordId: requisitionId,
    recordCode: String(pr.rows[0].pr_no),
    newValues: { attachmentId: Number(ins.rows[0].id), fileName },
  });
  return { attachmentId: Number(ins.rows[0].id) };
}

/** List document registrations for a requisition. */
export async function listPrAttachments(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  await client.query(
    `SELECT 1 FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  const res = await client.query(
    `SELECT a.id, a.file_name, a.file_path, a.mime_type, a.size_bytes, a.classification, a.created_at,
            u.username, u.first_name, u.last_name
     FROM pr_attachments a
     LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.requisition_id = $1
     ORDER BY a.id DESC LIMIT 100`,
    [requisitionId]
  );
  return toCamelRows(res.rows);
}

/** Upload an attachment for a requisition into the tenant-scoped document register. */
export async function uploadPrAttachment(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  input: { file: { originalname: string; mimetype: string; size: number; buffer: Buffer }; title?: string | null; classification?: string | null }
) {
  const pr = await client.query(
    `SELECT pr_no, company_id FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw notFound('Requisition not found');
  const file = input.file;
  if (!file || !file.buffer || file.buffer.length === 0) throw badRequest('A file is required');
  if (file.size > MAX_PR_ATTACHMENT_BYTES) throw badRequest('File exceeds the 10 MB limit');
  const mime = String(file.mimetype ?? '').toLowerCase();
  if (!PR_ATTACHMENT_TYPES.has(mime)) throw badRequest('Unsupported file type for a requisition attachment');
  const originalName = String(file.originalname ?? 'attachment.bin').replace(/[\\/]/g, '_');
  const checksum = createHash('sha256').update(file.buffer).digest('hex');
  const companyId = Number(pr.rows[0].company_id);
  const docNo = await nextDoc(client, ctx, `PRATT${companyId}`);
  const title = (input.title ?? '').trim() || originalName.replace(/\.[^.]+$/, '');
  const classification = String(input.classification ?? 'INTERNAL').toUpperCase();
  const safeName = originalName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const relDir = `procurement/${ctx.tenantId}/${requisitionId}`;
  const storageKey = `${relDir}/${docNo}-${safeName}`;
  mkdirSync(path.join(config.storageRoot, relDir), { recursive: true });
  writeFileSync(path.join(config.storageRoot, storageKey), file.buffer);

  const ins = await client.query(
    `INSERT INTO documents
       (company_id, tenant_id, doc_no, title, description, category, file_name, mime_type,
        file_size, storage_key, checksum, status, uploaded_by, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SUBMITTED',$12,$13)
     RETURNING id`,
    [companyId, ctx.tenantId, docNo, title, `Attachment for ${String(pr.rows[0].pr_no)}`, 'PR_ATTACHMENT',
     originalName, mime, file.buffer.length, storageKey, checksum, ctx.userId ?? null,
     JSON.stringify({ classification, sha256: checksum })]
  );
  const documentId = Number(ins.rows[0].id);
  await client.query(
    `INSERT INTO document_links (document_id, entity_type, entity_id) VALUES ($1, 'purchase_requisitions', $2)
     ON CONFLICT (document_id, entity_type, entity_id) DO NOTHING`,
    [documentId, requisitionId]
  );
  const meta = await client.query(
    `INSERT INTO pr_attachments
       (requisition_id, file_name, file_path, mime_type, size_bytes, classification, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [requisitionId, originalName, storageKey, mime, file.buffer.length, classification, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'upload',
    resource: 'purchase_requisitions',
    recordId: requisitionId,
    recordCode: String(pr.rows[0].pr_no),
    newValues: { documentId, attachmentId: Number(meta.rows[0].id), fileName: originalName, checksum },
  });
  return { attachmentId: Number(meta.rows[0].id), documentId, docNo, fileName: originalName, mimeType: mime, sizeBytes: file.buffer.length, checksum };
}

/** Stream a requisition attachment from tenant-scoped storage (path-traversal safe). */
export async function getPrAttachmentFile(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  attachmentId: number
) {
  const res = await client.query(
    `SELECT a.file_name, a.mime_type, a.file_path, a.size_bytes
     FROM pr_attachments a
     JOIN purchase_requisitions pr ON pr.id = a.requisition_id
     WHERE a.id = $1 AND a.requisition_id = $2 AND pr.tenant_id = $3`,
    [attachmentId, requisitionId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Attachment not found');
  const row = res.rows[0];
  const storageKey = String(row.file_path ?? '');
  if (!storageKey) throw notFound('Attachment has no stored file');
  const root = path.resolve(config.storageRoot);
  const abs = path.resolve(root, storageKey);
  if (!abs.startsWith(root + path.sep)) throw forbidden('Invalid attachment path');
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    throw notFound('Attachment file is missing');
  }
  return {
    buffer,
    fileName: String(row.file_name),
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    sizeBytes: Number(row.size_bytes) || buffer.length,
  };
}

/** Assign a procurement officer to own a requisition. */
export async function assignRequisition(
  client: pg.PoolClient,
  ctx: Ctx,
  requisitionId: number,
  input: { officerUserId: number; notes?: string | null }
) {
  const officer = Number(input.officerUserId);
  if (!officer) throw badRequest('officerUserId is required');
  const pr = await client.query(
    `SELECT pr_no, status FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  if (pr.rows.length === 0) throw notFound('Requisition not found');
  const u = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [officer, ctx.tenantId]
  );
  if (u.rows.length === 0) throw badRequest('Officer must be an active user of this tenant');
  await client.query(
    `INSERT INTO pr_assignments (requisition_id, officer_user_id, assigned_by, notes)
     VALUES ($1,$2,$3,$4)`,
    [requisitionId, officer, ctx.userId ?? null, input.notes ?? null]
  );
  await client.query(
    `UPDATE purchase_requisitions SET procurement_officer_id = $1 WHERE id = $2`,
    [officer, requisitionId]
  );
  await logAudit(client, ctx, {
    action: 'assign',
    resource: 'purchase_requisitions',
    recordId: requisitionId,
    recordCode: String(pr.rows[0].pr_no),
    newValues: { officerUserId: officer },
    metadata: { notes: input.notes ?? null },
  });
  await notifyUserAdvanced(client, ctx, officer, {
    type: 'PR_ASSIGNMENT',
    title: `Assigned to ${String(pr.rows[0].pr_no)}`,
    body: `You are the procurement officer for ${String(pr.rows[0].pr_no)}`,
    link: `/buy/requisitions/${requisitionId}`,
    entityType: 'purchase_requisitions',
    entityId: requisitionId,
    actionRequired: true,
    severity: 'INFO',
  });
  return { requisitionId, prNo: String(pr.rows[0].pr_no), officerUserId: officer };
}

/** Assignment history for a requisition. */
export async function listPrAssignments(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  await client.query(
    `SELECT 1 FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  const res = await client.query(
    `SELECT a.id, a.officer_user_id, a.assigned_at, a.notes,
            u.username, u.first_name, u.last_name
     FROM pr_assignments a
     LEFT JOIN users u ON u.id = a.officer_user_id
     WHERE a.requisition_id = $1
     ORDER BY a.id DESC LIMIT 100`,
    [requisitionId]
  );
  return toCamelRows(res.rows);
}

/** Users eligible to be assigned as procurement officers (procurement roles). */
export async function listPrAssignees(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT DISTINCT u.id, u.username, u.first_name, u.last_name, u.job_title, u.status,
            array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.tenant_id = $1 AND u.status = 'ACTIVE'
       AND (r.code ILIKE 'procurement%' OR u.id = $2)
     GROUP BY u.id
     ORDER BY u.first_name, u.last_name
     LIMIT 200`,
    [ctx.tenantId, ctx.userId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Immutable status-history trail for a requisition. */
export async function requisitionHistory(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  await client.query(
    `SELECT 1 FROM purchase_requisitions WHERE id = $1 AND tenant_id = $2`,
    [requisitionId, ctx.tenantId]
  );
  const res = await client.query(
    `SELECT h.id, h.from_status, h.to_status, h.comment, h.created_at,
            u.username, u.first_name, u.last_name
     FROM pr_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.requisition_id = $1
     ORDER BY h.id`,
    [requisitionId]
  );
  return toCamelRows(res.rows);
}

/** Inventory advisory for every line: on-hand vs requested, transfer vs procure. */
export async function requisitionInventoryCheck(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name, p.type AS product_type,
            p.safety_stock, i.quantity, i.ordered_qty
     FROM purchase_requisition_items i
     JOIN products p ON p.id = i.product_id
     WHERE i.requisition_id = $1
     ORDER BY i.id`,
    [requisitionId]
  );
  if (res.rows.length === 0) throw notFound('Requisition not found or has no items');
  const rows: Record<string, unknown>[] = [];
  for (const r of res.rows) {
    const stock = await productStock(client, ctx, Number(r.product_id));
    const locations = (stock.locations as Record<string, unknown>[]) ?? [];
    let onHand = 0;
    let available = 0;
    for (const l of locations) {
      onHand += Number(l.quantity) || 0;
      available += Number(l.available_qty) || 0;
    }
    const requested = Number(r.quantity);
    let recommendation: string;
    let action: string;
    if (available >= requested) {
      recommendation = 'Available stock is sufficient. Internal stock transfer recommended.';
      action = 'TRANSFER';
    } else if (onHand > 0) {
      recommendation = `Only ${onHand} available across warehouses. Procurement recommended for the shortfall of ${Math.max(0, requested - available)}.`;
      action = 'PARTIAL';
    } else {
      recommendation = 'No available stock. Procurement recommended.';
      action = 'PROCURE';
    }
    rows.push({
      lineItemId: Number(r.id),
      productId: Number(r.product_id),
      productCode: String(r.product_code),
      productName: String(r.product_name),
      productType: String(r.product_type ?? ''),
      requested,
      onHand,
      available,
      orderedQty: Number(r.ordered_qty) || 0,
      safetyStock: Number(r.safety_stock) || 0,
      recommendation,
      action,
    });
  }
  return { rows };
}

// ---------- Three-way match (PO <-> GRN <-> Invoice) ----------

export type ThreeWayLineStatus =
  | 'MATCHED'
  | 'PARTIAL'
  | 'DIFFERENCE'
  | 'NOT_RECEIVED'
  | 'NOT_INVOICED'
  | 'PENDING';
export type ThreeWayMatchStatus = 'MATCHED' | 'PARTIAL' | 'DIFFERENCE' | 'PENDING';

const MATCH_QTY_TOLERANCE = 0;
const MATCH_PRICE_TOLERANCE_PCT = 1;

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function threeWayLineStatus(ordered: number, received: number, invoiced: number): ThreeWayLineStatus {
  if (received === 0 && invoiced === 0) return 'PENDING';
  if (received === 0) return 'NOT_RECEIVED';
  if (invoiced === 0) return 'NOT_INVOICED';
  if (Math.abs(invoiced - received) > MATCH_QTY_TOLERANCE) return 'DIFFERENCE';
  if (Math.abs(received - ordered) > MATCH_QTY_TOLERANCE) return 'PARTIAL';
  return 'MATCHED';
}

function threeWayHeaderStatus(lines: { status: ThreeWayLineStatus }[]): ThreeWayMatchStatus {
  if (!lines.length) return 'PENDING';
  if (lines.some((l) => l.status === 'DIFFERENCE' || l.status === 'NOT_RECEIVED')) return 'DIFFERENCE';
  if (lines.every((l) => l.status === 'MATCHED')) return 'MATCHED';
  if (lines.some((l) => l.status === 'PARTIAL' || l.status === 'NOT_INVOICED')) return 'PARTIAL';
  return 'PENDING';
}

export async function getThreeWayMatch(
  client: pg.PoolClient,
  ctx: Ctx,
  poId: number,
  opts: { priceTolerancePct?: number } = {}
) {
  const priceTolerance =
    opts.priceTolerancePct != null && opts.priceTolerancePct >= 0 ? opts.priceTolerancePct : MATCH_PRICE_TOLERANCE_PCT;

  const poRes = await client.query(
    `SELECT po.*, s.code AS supplier_code, s.name AS supplier_name, s.tin AS supplier_tin, pr.pr_no
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [poId, ctx.tenantId]
  );
  if (poRes.rows.length === 0) throw notFound('Purchase order not found');
  const po = poRes.rows[0];

  const itemsRes = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = $1 ORDER BY i.id`,
    [poId]
  );

  const grnRes = await client.query(
    `SELECT gi.po_item_id,
            COALESCE(SUM(gi.quantity_received), 0)::numeric AS received_qty,
            COALESCE(SUM(gi.quantity_accepted), 0)::numeric AS accepted_qty,
            COALESCE(SUM(gi.quantity_rejected), 0)::numeric AS rejected_qty,
            COALESCE(SUM(gi.quantity_received * gi.unit_cost), 0)::numeric AS received_amount
     FROM goods_receipt_items gi
     JOIN goods_receipts g ON g.id = gi.grn_id
     WHERE g.po_id = $1 AND g.tenant_id = $2 AND g.status <> 'REJECTED'
     GROUP BY gi.po_item_id`,
    [poId, ctx.tenantId]
  );
  const grnByItem = new Map<number, Record<string, unknown>>();
  for (const r of grnRes.rows) grnByItem.set(Number(r.po_item_id), r);

  const invRes = await client.query(
    `SELECT sii.po_item_id,
            COALESCE(SUM(sii.quantity), 0)::numeric AS invoiced_qty,
            COALESCE(SUM(sii.line_total), 0)::numeric AS invoiced_amount,
            COUNT(DISTINCT si.id)::int AS invoice_count
     FROM supplier_invoice_items sii
     JOIN supplier_invoices si ON si.id = sii.invoice_id
     WHERE si.po_id = $1 AND si.tenant_id = $2 AND si.status <> 'VOID'
     GROUP BY sii.po_item_id`,
    [poId, ctx.tenantId]
  );
  const invByItem = new Map<number, Record<string, unknown>>();
  for (const r of invRes.rows) invByItem.set(Number(r.po_item_id), r);

  interface MatchLine {
    poItemId: number;
    productId: number;
    productCode: string;
    productName: string;
    orderedQty: number;
    receivedQty: number;
    acceptedQty: number;
    rejectedQty: number;
    invoicedQty: number;
    unitPrice: number;
    invoiceUnitPrice: number;
    receivedAmount: number;
    invoicedAmount: number;
    priceVariancePct: number;
    priceFlag: string;
    status: ThreeWayLineStatus;
  }
  const lines: MatchLine[] = [];
  let orderedTotal = 0;
  let receivedTotal = 0;
  let invoicedTotal = 0;
  for (const it of itemsRes.rows) {
    const ordered = asNum(it.quantity);
    const received = asNum(it.received_qty);
    const invoiced = asNum(it.invoiced_qty);
    const poUnitPrice = asNum(it.unit_price);
    const grn = grnByItem.get(Number(it.id));
    const inv = invByItem.get(Number(it.id));
    const receivedAmount = grn ? asNum(grn.received_amount) : 0;
    const invoicedAmount = inv ? asNum(inv.invoiced_amount) : 0;
    const invoiceUnitPrice = invoiced > 0 ? invoicedAmount / invoiced : 0;
    const priceVariancePct =
      invoiced > 0 && poUnitPrice > 0 ? ((invoiceUnitPrice - poUnitPrice) / poUnitPrice) * 100 : 0;
    const status = threeWayLineStatus(ordered, received, invoiced);
    const priceFlag =
      invoiced === 0
        ? 'N/A'
        : Math.abs(priceVariancePct) <= priceTolerance
          ? 'WITHIN_TOLERANCE'
          : priceVariancePct > 0
            ? 'ABOVE_TOLERANCE'
            : 'BELOW_TOLERANCE';
    orderedTotal += ordered * poUnitPrice;
    receivedTotal += receivedAmount;
    invoicedTotal += invoicedAmount;
    lines.push({
      poItemId: Number(it.id),
      productId: Number(it.product_id),
      productCode: String(it.product_code),
      productName: String(it.product_name),
      orderedQty: ordered,
      receivedQty: received,
      acceptedQty: grn ? asNum(grn.accepted_qty) : 0,
      rejectedQty: grn ? asNum(grn.rejected_qty) : 0,
      invoicedQty: invoiced,
      unitPrice: round2(poUnitPrice),
      invoiceUnitPrice: round2(invoiceUnitPrice),
      receivedAmount: round2(receivedAmount),
      invoicedAmount: round2(invoicedAmount),
      priceVariancePct: round2(priceVariancePct),
      priceFlag,
      status,
    });
  }

  const matchStatus = threeWayHeaderStatus(lines);

  const grns = await client.query(
    `SELECT g.id, g.grn_no, g.status, g.received_at, g.delivery_ref, u.username AS received_by_name,
            (SELECT COALESCE(SUM(gi.quantity_received), 0) FROM goods_receipt_items gi WHERE gi.grn_id = g.id)::numeric AS total_qty,
            (SELECT COALESCE(SUM(gi.quantity_received * gi.unit_cost), 0) FROM goods_receipt_items gi WHERE gi.grn_id = g.id)::numeric AS total_amount
     FROM goods_receipts g
     LEFT JOIN users u ON u.id = g.received_by
     WHERE g.po_id = $1 AND g.tenant_id = $2
     ORDER BY g.id`,
    [poId, ctx.tenantId]
  );

  const invoices = await client.query(
    `SELECT si.id, si.supplier_invoice_no, si.status, si.invoice_date, si.due_date, si.total, si.amount_paid, si.three_way_matched,
            (SELECT COALESCE(SUM(sii.quantity), 0) FROM supplier_invoice_items sii WHERE sii.invoice_id = si.id)::numeric AS total_qty
     FROM supplier_invoices si
     WHERE si.po_id = $1 AND si.tenant_id = $2
     ORDER BY si.id`,
    [poId, ctx.tenantId]
  );

  const count = (s: ThreeWayLineStatus) => lines.filter((l) => l.status === s).length;
  return {
    po: {
      id: Number(po.id),
      poNo: po.po_no,
      status: po.status,
      orderDate: po.order_date,
      expectedDate: po.expected_date,
      total: Number(po.total),
      currency: po.currency,
      threeWayMatched: Boolean(po.three_way_matched),
      supplierCode: po.supplier_code,
      supplierName: po.supplier_name,
      supplierTin: po.supplier_tin ?? null,
      prNo: po.pr_no ?? null,
    },
    lines,
    grns: toCamelRows(grns.rows),
    invoices: toCamelRows(invoices.rows),
    summary: {
      matchStatus,
      threeWayMatched: matchStatus === 'MATCHED',
      orderedTotal: round2(orderedTotal),
      receivedTotal: round2(receivedTotal),
      invoicedTotal: round2(invoicedTotal),
      varianceTotal: round2(invoicedTotal - receivedTotal),
      priceTolerancePct: priceTolerance,
      qtyTolerance: MATCH_QTY_TOLERANCE,
      lineCounts: {
        total: lines.length,
        matched: count('MATCHED'),
        partial: count('PARTIAL'),
        difference: count('DIFFERENCE'),
        notReceived: count('NOT_RECEIVED'),
        notInvoiced: count('NOT_INVOICED'),
        pending: count('PENDING'),
      },
    },
  };
}

export async function listMatchDesk(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; match?: string; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = [
    'po.tenant_id = $1',
    'po.company_id = $2',
    "po.status IN ('APPROVED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')",
  ];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(po.po_no ILIKE $${params.length} OR s.name ILIKE $${params.length} OR s.code ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`po.status = $${params.length}`);
  }
  if (filters.match) {
    params.push(String(filters.match).toUpperCase());
    where.push(`pm.match_status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `WITH line_match AS (
       SELECT i.order_id,
              COUNT(*)::int AS line_count,
              COUNT(*) FILTER (WHERE i.invoiced_qty > 0 AND i.received_qty = 0)::int AS not_received_lines,
              COUNT(*) FILTER (WHERE i.invoiced_qty <> i.received_qty)::int AS difference_lines,
              COUNT(*) FILTER (WHERE i.received_qty = 0 AND i.invoiced_qty = 0)::int AS pending_lines,
              COUNT(*) FILTER (WHERE i.received_qty = i.invoiced_qty AND i.received_qty = i.quantity AND i.received_qty > 0)::int AS matched_lines
       FROM purchase_order_items i
       GROUP BY i.order_id
     ),
     po_match AS (
       SELECT lm.order_id, lm.line_count, lm.difference_lines, lm.pending_lines, lm.matched_lines,
              CASE
                WHEN lm.line_count = 0 OR lm.pending_lines = lm.line_count THEN 'PENDING'
                WHEN lm.difference_lines > 0 THEN 'DIFFERENCE'
                WHEN lm.matched_lines = lm.line_count THEN 'MATCHED'
                ELSE 'PARTIAL'
              END AS match_status
       FROM line_match lm
     )
     SELECT po.id, po.po_no, po.status, po.order_date, po.expected_date, po.total, po.currency, po.three_way_matched,
            s.code AS supplier_code, s.name AS supplier_name,
            (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_order_items i WHERE i.order_id = po.id)::numeric AS ordered_qty,
            (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.order_id = po.id)::numeric AS received_qty,
            (SELECT COALESCE(SUM(i.invoiced_qty), 0) FROM purchase_order_items i WHERE i.order_id = po.id)::numeric AS invoiced_qty,
            (SELECT count(*) FROM goods_receipts g WHERE g.po_id = po.id)::int AS grn_count,
            (SELECT count(*) FROM supplier_invoices si WHERE si.po_id = po.id AND si.status <> 'VOID')::int AS invoice_count,
            COALESCE(pm.match_status, 'PENDING') AS match_status,
            COALESCE(pm.line_count, 0)::int AS line_count,
            COALESCE(pm.matched_lines, 0)::int AS matched_lines
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN po_match pm ON pm.order_id = po.id
     WHERE ${where.join(' AND ')}
     ORDER BY po.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const rows = res.rows.map((r) => ({
    id: Number(r.id),
    poNo: r.po_no,
    status: r.status,
    orderDate: r.order_date,
    expectedDate: r.expected_date,
    total: Number(r.total),
    currency: r.currency,
    threeWayMatched: Boolean(r.three_way_matched),
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    orderedQty: Number(r.ordered_qty),
    receivedQty: Number(r.received_qty),
    invoicedQty: Number(r.invoiced_qty),
    grnCount: Number(r.grn_count),
    invoiceCount: Number(r.invoice_count),
    matchStatus: r.match_status,
    lineCounts: {
      total: Number(r.line_count),
      matched: Number(r.matched_lines),
    },
  }));
  return { rows, page, pageSize };
}

export async function runThreeWayMatch(client: pg.PoolClient, ctx: Ctx, poId: number) {
  const match = await getThreeWayMatch(client, ctx, poId);
  const matched = match.summary.threeWayMatched;
  await client.query(`UPDATE purchase_orders SET three_way_matched = $1, updated_at = now() WHERE id = $2`, [
    matched,
    poId,
  ]);
  await client.query(
    `UPDATE supplier_invoices SET three_way_matched = $1, updated_at = now()
     WHERE po_id = $2 AND tenant_id = $3 AND status <> 'VOID'`,
    [matched, poId, ctx.tenantId]
  );
  await logAudit(client, ctx, {
    action: matched ? 'THREE_WAY_MATCHED' : 'THREE_WAY_MATCH_DIFFERENCE',
    resource: 'procurement.po',
    recordId: poId,
    recordCode: match.po.poNo,
    metadata: {
      matchStatus: match.summary.matchStatus,
      receivedTotal: match.summary.receivedTotal,
      invoicedTotal: match.summary.invoicedTotal,
      varianceTotal: match.summary.varianceTotal,
    },
  });
  return { ...match, persisted: true };
}
