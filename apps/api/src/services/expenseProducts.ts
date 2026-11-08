import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

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

function companyId(ctx: Ctx): number {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.category_group,
         a.code AS account_code, a.name AS account_name,
         t.name AS tax_name
  FROM expense_products p
  LEFT JOIN expense_categories c ON c.id = p.category_id
  LEFT JOIN chart_of_accounts a ON a.id = p.account_id
  LEFT JOIN taxes t ON t.id = p.tax_id
`;

export async function listExpenseProducts(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['p.tenant_id = $1', 'p.company_id = $2'];
  if (q.includeInactive !== true) where.push('p.is_active = true');
  if (s(q.q)) { params.push(`%${s(q.q)}%`); where.push(`(p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`); }
  const rows = await client.query(
    `${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`,
    params
  );
  return toCamelRows(rows.rows);
}

export async function expenseProductsMeta(client: pg.PoolClient, ctx: Ctx) {
  const cats = await client.query(
    `SELECT id, code, name, category_group FROM expense_categories
     WHERE company_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  const accounts = await client.query(
    `SELECT id, code, name FROM chart_of_accounts
     WHERE company_id = $1 AND tenant_id = $2 AND is_active = true AND account_type IN ('EXPENSE','COST_OF_SALES')
     ORDER BY code`,
    [companyId(ctx), ctx.tenantId]
  );
  const taxes = await client.query(
    `SELECT id, code, name FROM taxes WHERE company_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return { categories: toCamelRows(cats.rows), accounts: toCamelRows(accounts.rows), taxes: toCamelRows(taxes.rows) };
}

export async function getExpenseProduct(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `${PRODUCT_SELECT} WHERE p.id = $1 AND p.tenant_id = $2 AND p.company_id = $3`,
    [id, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Expense product not found');
  return toCamelRow(res.rows[0]);
}

export async function createExpenseProduct(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const code = String(b.code ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!code) throw badRequest('Product code is required');
  if (!name) throw badRequest('Product name is required');
  const ins = await client.query(
    `INSERT INTO expense_products
       (company_id, tenant_id, code, name, description, default_price, category_id, account_id, tax_id, unit_code, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
    [companyId(ctx), ctx.tenantId, code, name, s(b.description), num0(b.defaultPrice), n(b.categoryId), n(b.accountId), n(b.taxId), s(b.unitCode)]
  );
  const id = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'expenses.expense_products', recordId: id, recordCode: code, newValues: { name } });
  return getExpenseProduct(client, ctx, id);
}

export async function updateExpenseProduct(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const cur = await getExpenseProduct(client, ctx, id);
  const code = b.code != null ? String(b.code).trim() : String(cur.code);
  const name = b.name != null ? String(b.name).trim() : String(cur.name);
  if (!code) throw badRequest('Product code is required');
  if (!name) throw badRequest('Product name is required');
  await client.query(
    `UPDATE expense_products
        SET code = $2, name = $3, description = $4, default_price = $5,
            category_id = $6, account_id = $7, tax_id = $8, unit_code = $9, updated_at = now()
      WHERE id = $1`,
    [id, code, name,
     b.description != null ? s(b.description) : s(cur.description),
     b.defaultPrice != null ? num0(b.defaultPrice) : num0(cur.defaultPrice),
     b.categoryId != null ? n(b.categoryId) : n(cur.categoryId),
     b.accountId != null ? n(b.accountId) : n(cur.accountId),
     b.taxId != null ? n(b.taxId) : n(cur.taxId),
     b.unitCode != null ? s(b.unitCode) : s(cur.unitCode)]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'expenses.expense_products', recordId: id, recordCode: code, newValues: { name } });
  return getExpenseProduct(client, ctx, id);
}

export async function setExpenseProductActive(client: pg.PoolClient, ctx: Ctx, id: number, active: boolean) {
  const cur = await getExpenseProduct(client, ctx, id);
  await client.query(`UPDATE expense_products SET is_active = $2, updated_at = now() WHERE id = $1`, [id, active]);
  await logAudit(client, ctx, { action: active ? 'activate' : 'deactivate', resource: 'expenses.expense_products', recordId: id, recordCode: String(cur.code), newValues: { isActive: active } });
  return getExpenseProduct(client, ctx, id);
}
