import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Odoo 19 Sales screens that sit beside the quotation and order services:
 * teams, quotation templates, orders to invoice, orders to upsell, and sales analysis.
 * Orders to invoice are orders with dispatched quantity still unbilled.
 * That matches the existing invoice rule (delivered quantities only).
 */

const LINE_KINDS = new Set(['PRODUCT', 'SECTION', 'NOTE']);

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export async function listSalespeople(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, first_name, last_name, email
     FROM users
     WHERE tenant_id = $1 AND status = 'ACTIVE'
     ORDER BY first_name, last_name
     LIMIT 300`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

export async function listTeams(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT t.id, t.name, t.leader_user_id, t.active,
            TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS leader_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                'userId', m.user_id,
                'name', TRIM(BOTH FROM COALESCE(mu.first_name,'') || ' ' || COALESCE(mu.last_name,''))
              ) ORDER BY mu.first_name)
              FROM sales_team_members m
              JOIN users mu ON mu.id = m.user_id
              WHERE m.team_id = t.id
            ), '[]'::json) AS members
     FROM sales_teams t
     LEFT JOIN users u ON u.id = t.leader_user_id
     WHERE t.tenant_id = $1 AND t.company_id = $2
     ORDER BY t.active DESC, t.name`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

async function assertUser(client: pg.PoolClient, ctx: Ctx, userId: number) {
  const res = await client.query(
    `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [userId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Salesperson was not found');
}

export async function saveTeam(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { id?: number | null; name?: string; leaderUserId?: number | null; active?: boolean; memberIds?: number[] }
) {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Sales team name is required');
  const leader = input.leaderUserId != null && input.leaderUserId !== 0 ? Number(input.leaderUserId) : null;
  if (leader != null) await assertUser(client, ctx, leader);
  const memberIds = [...new Set((input.memberIds ?? []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  for (const id of memberIds) await assertUser(client, ctx, id);
  const active = input.active !== false;
  let teamId = input.id != null ? Number(input.id) : 0;
  if (teamId > 0) {
    const cur = await client.query(
      `SELECT id FROM sales_teams WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [teamId, ctx.tenantId]
    );
    if (cur.rows.length === 0) throw notFound('Sales team not found');
    await client.query(
      `UPDATE sales_teams SET name = $1, leader_user_id = $2, active = $3, updated_at = now() WHERE id = $4`,
      [name, leader, active, teamId]
    );
  } else {
    const ins = await client.query(
      `INSERT INTO sales_teams (company_id, tenant_id, name, leader_user_id, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.companyId, ctx.tenantId, name, leader, active]
    );
    teamId = Number(ins.rows[0].id);
  }
  await client.query(`DELETE FROM sales_team_members WHERE team_id = $1`, [teamId]);
  for (const userId of memberIds) {
    await client.query(
      `INSERT INTO sales_team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [teamId, userId]
    );
  }
  await logAudit(client, ctx, { action: 'save', resource: 'sales_teams', recordId: teamId, newValues: { name, leader, memberIds } });
  return { teamId };
}

export async function listTemplates(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT t.id, t.name, t.validity_days, t.notes, t.active,
            (SELECT count(*) FROM quotation_template_lines l WHERE l.template_id = t.id)::int AS line_count
     FROM quotation_templates t
     WHERE t.tenant_id = $1 AND t.company_id = $2
     ORDER BY t.active DESC, t.name`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getTemplate(client: pg.PoolClient, ctx: Ctx, templateId: number) {
  const res = await client.query(
    `SELECT * FROM quotation_templates WHERE id = $1 AND tenant_id = $2`,
    [templateId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Quotation template not found');
  const lines = await client.query(
    `SELECT l.*, p.code AS product_code, p.name AS product_name, p.standard_price, p.standard_cost, p.weight_per_unit, p.unit_id
     FROM quotation_template_lines l
     LEFT JOIN products p ON p.id = l.product_id
     WHERE l.template_id = $1
     ORDER BY l.sequence, l.id`,
    [templateId]
  );
  return { template: toCamelRows([res.rows[0]])[0], lines: toCamelRows(lines.rows) };
}

interface TemplateLineInput {
  lineKind?: string;
  productId?: number | null;
  description?: string | null;
  quantity?: number;
  unitPrice?: number;
  discountPercent?: number;
}

export async function saveTemplate(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { id?: number | null; name?: string; validityDays?: number | null; notes?: string | null; active?: boolean; lines?: TemplateLineInput[] }
) {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Template name is required');
  const validity = input.validityDays == null || input.validityDays === ('' as unknown)
    ? null
    : Number(input.validityDays);
  if (validity != null && (!Number.isInteger(validity) || validity < 0 || validity > 365)) {
    throw badRequest('Template validity must be a whole number of days from 0 to 365');
  }
  const lines = input.lines ?? [];
  if (lines.length === 0) throw badRequest('Add at least one template line');
  let templateId = input.id != null ? Number(input.id) : 0;
  const active = input.active !== false;
  if (templateId > 0) {
    const cur = await client.query(
      `SELECT id FROM quotation_templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [templateId, ctx.tenantId]
    );
    if (cur.rows.length === 0) throw notFound('Quotation template not found');
    await client.query(
      `UPDATE quotation_templates
         SET name = $1, validity_days = $2, notes = $3, active = $4, updated_at = now()
       WHERE id = $5`,
      [name, validity, textOrNull(input.notes), active, templateId]
    );
    await client.query(`DELETE FROM quotation_template_lines WHERE template_id = $1`, [templateId]);
  } else {
    const ins = await client.query(
      `INSERT INTO quotation_templates (company_id, tenant_id, name, validity_days, notes, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.companyId, ctx.tenantId, name, validity, textOrNull(input.notes), active, ctx.userId ?? null]
    );
    templateId = Number(ins.rows[0].id);
  }
  let products = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kind = String(line.lineKind ?? 'PRODUCT').toUpperCase();
    if (!LINE_KINDS.has(kind)) throw badRequest('Template line kind must be PRODUCT, SECTION, or NOTE');
    if (kind !== 'PRODUCT') {
      const description = textOrNull(line.description);
      if (!description) throw badRequest(kind === 'SECTION' ? 'A section needs a title' : 'A note needs text');
      await client.query(
        `INSERT INTO quotation_template_lines
           (template_id, sequence, line_kind, product_id, description, quantity, unit_price, discount_percent)
         VALUES ($1,$2,$3,NULL,$4,0,0,0)`,
        [templateId, i, kind, description]
      );
      continue;
    }
    const productId = Number(line.productId);
    if (!Number.isInteger(productId) || productId <= 0) throw badRequest('Each product line needs a product');
    const product = await client.query(
      `SELECT id, name FROM products WHERE id = $1 AND tenant_id = $2`,
      [productId, ctx.tenantId]
    );
    if (product.rows.length === 0) throw badRequest(`Product ${productId} not found`);
    const qty = Number(line.quantity ?? 1);
    if (!(qty > 0)) throw badRequest('Quantity must be positive');
    products++;
    await client.query(
      `INSERT INTO quotation_template_lines
         (template_id, sequence, line_kind, product_id, description, quantity, unit_price, discount_percent)
       VALUES ($1,$2,'PRODUCT',$3,$4,$5,$6,$7)`,
      [
        templateId, i, productId,
        textOrNull(line.description) ?? String(product.rows[0].name),
        qty, Number(line.unitPrice ?? 0), Number(line.discountPercent ?? 0),
      ]
    );
  }
  if (products === 0) throw badRequest('A template needs at least one product');
  await logAudit(client, ctx, { action: 'save', resource: 'quotation_templates', recordId: templateId, newValues: { name } });
  return { templateId };
}

/** Orders with goods dispatched and not yet fully invoiced. */
export async function listOrdersToInvoice(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT so.id, so.order_no, so.status, so.order_date, so.total, so.customer_id,
            c.name AS customer_name,
            COALESCE(sum(i.quantity) FILTER (WHERE i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'), 0)::numeric AS ordered_qty,
            COALESCE(sum(i.dispatched_qty) FILTER (WHERE i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'), 0)::numeric AS dispatched_qty,
            COALESCE(sum(i.invoiced_qty) FILTER (WHERE i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'), 0)::numeric AS invoiced_qty
     FROM sales_orders so
     JOIN customers c ON c.id = so.customer_id
     JOIN sales_order_items i ON i.order_id = so.id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status IN ('DISPATCHED','PARTIALLY_DISPATCHED','INVOICED')
     GROUP BY so.id, c.name
     HAVING COALESCE(sum(i.dispatched_qty) FILTER (WHERE i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'), 0)
          > COALESCE(sum(i.invoiced_qty) FILTER (WHERE i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'), 0)
     ORDER BY so.id DESC
     LIMIT 100`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

/** Confirmed orders that still have optional products the customer has not taken. */
export async function listOrdersToUpsell(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT so.id, so.order_no, so.status, so.order_date, so.customer_id, c.name AS customer_name,
            json_agg(json_build_object(
              'productId', o.product_id,
              'description', COALESCE(o.description, p.name),
              'quantity', o.quantity,
              'unitPrice', o.unit_price
            ) ORDER BY o.sequence, o.id) AS optionals
     FROM sales_orders so
     JOIN customers c ON c.id = so.customer_id
     JOIN sales_order_optionals o ON o.order_id = so.id
     JOIN products p ON p.id = o.product_id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status NOT IN ('CANCELLED','REJECTED')
       AND NOT EXISTS (
         SELECT 1 FROM sales_order_items i
         WHERE i.order_id = so.id AND i.product_id = o.product_id
           AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'
       )
     GROUP BY so.id, c.name
     ORDER BY so.id DESC
     LIMIT 100`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

const GROUPS = new Set(['customer', 'salesperson', 'product', 'team']);

export async function salesAnalysis(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { groupBy?: string; from?: string; to?: string }
) {
  const groupBy = GROUPS.has(String(filters.groupBy ?? '')) ? String(filters.groupBy) : 'customer';
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const params: unknown[] = [ctx.tenantId, ctx.companyId, from, to];
  const dateSql = `($3::date IS NULL OR so.order_date >= $3::date) AND ($4::date IS NULL OR so.order_date <= $4::date)`;
  const statusSql = `so.status NOT IN ('CANCELLED','REJECTED','DRAFT')`;
  let sql: string;
  if (groupBy === 'product') {
    sql = `SELECT COALESCE(p.name, i.description, 'Product') AS label,
                  count(DISTINCT so.id)::int AS orders,
                  COALESCE(sum(i.line_total),0)::numeric AS total
           FROM sales_order_items i
           JOIN sales_orders so ON so.id = i.order_id
           LEFT JOIN products p ON p.id = i.product_id
           WHERE so.tenant_id = $1 AND so.company_id = $2 AND ${statusSql} AND ${dateSql}
             AND i.product_id IS NOT NULL AND COALESCE(i.line_kind,'PRODUCT') = 'PRODUCT'
           GROUP BY 1
           ORDER BY total DESC
           LIMIT 80`;
  } else if (groupBy === 'salesperson') {
    sql = `SELECT COALESCE(NULLIF(TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), 'Unassigned') AS label,
                  count(*)::int AS orders,
                  COALESCE(sum(so.total),0)::numeric AS total
           FROM sales_orders so
           LEFT JOIN users u ON u.id = COALESCE(so.salesperson_id, so.created_by)
           WHERE so.tenant_id = $1 AND so.company_id = $2 AND ${statusSql} AND ${dateSql}
           GROUP BY 1
           ORDER BY total DESC
           LIMIT 80`;
  } else if (groupBy === 'team') {
    sql = `SELECT COALESCE(t.name, 'No team') AS label,
                  count(*)::int AS orders,
                  COALESCE(sum(so.total),0)::numeric AS total
           FROM sales_orders so
           LEFT JOIN sales_teams t ON t.id = so.sales_team_id
           WHERE so.tenant_id = $1 AND so.company_id = $2 AND ${statusSql} AND ${dateSql}
           GROUP BY 1
           ORDER BY total DESC
           LIMIT 80`;
  } else {
    sql = `SELECT c.name AS label,
                  count(*)::int AS orders,
                  COALESCE(sum(so.total),0)::numeric AS total
           FROM sales_orders so
           JOIN customers c ON c.id = so.customer_id
           WHERE so.tenant_id = $1 AND so.company_id = $2 AND ${statusSql} AND ${dateSql}
           GROUP BY c.name
           ORDER BY total DESC
           LIMIT 80`;
  }
  const res = await client.query(sql, params);
  return { groupBy, rows: toCamelRows(res.rows) };
}
