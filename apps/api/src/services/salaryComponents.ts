import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, parsePagination, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Odoo "Salary Rules" parity — the payroll component catalogue.
 *
 * The payroll engine reads `payroll_component_definitions` (joined to
 * `employee_payroll_components`) as its live component source. Until now the
 * catalogue was only editable through the generic record registry; this service
 * exposes it as a first-class payroll configuration resource with the same
 * enum validation the schema enforces, so a rule can never be saved in a shape
 * the engine cannot resolve.
 */

const TYPES = ['EARNING', 'DEDUCTION'];
const CATEGORIES = ['ALLOWANCE', 'BONUS', 'OVERTIME', 'REIMBURSEMENT', 'LOAN', 'ADVANCE', 'TAX', 'STATUTORY', 'OTHER'];
const CALCULATION_TYPES = ['FIXED', 'PERCENTAGE', 'FORMULA'];

const COLS = [
  'code',
  'name',
  'type',
  'category',
  'is_taxable',
  'is_benefit_in_kind',
  'calculation_type',
  'value',
  'formula',
  'status',
] as const;

const round4 = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
};

const asText = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

/** Coerce and validate the writable catalogue fields; throws on invalid input. */
function parseInput(input: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of COLS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (key === 'code' || key === 'name') {
      const s = asText(v);
      if (s === undefined) {
        if (partial) continue;
        throw badRequest(`${key} is required`);
      }
      out[key] = s;
    } else if (key === 'type' || key === 'category' || key === 'calculation_type' || key === 'status') {
      const s = asText(v);
      if (s === undefined) continue;
      const allowed = key === 'type' ? TYPES : key === 'category' ? CATEGORIES : key === 'calculation_type' ? CALCULATION_TYPES : ['ACTIVE', 'INACTIVE'];
      if (!allowed.includes(s)) throw badRequest(`${key} must be one of ${allowed.join(', ')}`);
      out[key] = s;
    } else if (key === 'is_taxable' || key === 'is_benefit_in_kind') {
      out[key] = v === true || v === 'true' || v === 1 || v === '1';
    } else if (key === 'value') {
      out[key] = round4(v);
    } else if (key === 'formula') {
      out[key] = v;
    }
  }
  return out;
}

export async function listSalaryComponents(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; type?: string; category?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['tenant_id = $1', 'company_id = $2'];
  if (filters.type) {
    params.push(filters.type);
    where.push('type = $' + params.length);
  }
  if (filters.category) {
    params.push(filters.category);
    where.push('category = $' + params.length);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push('status = $' + params.length);
  }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(code ILIKE $' + params.length + ' OR name ILIKE $' + params.length + ')');
  }
  params.push(pageSize, offset);
  const res = await client.query(
    `SELECT d.*, (SELECT count(*)::int FROM employee_payroll_components epc
                   WHERE epc.component_id = d.id AND epc.status = 'ACTIVE' AND epc.tenant_id = d.tenant_id) AS assigned_count
       FROM payroll_component_definitions d
      WHERE ${where.join(' AND ')}
      ORDER BY d.code ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await client.query(
    `SELECT count(*)::int AS n FROM payroll_component_definitions d WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

export async function getSalaryComponent(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT d.*, (SELECT count(*)::int FROM employee_payroll_components epc
                   WHERE epc.component_id = d.id AND epc.status = 'ACTIVE' AND epc.tenant_id = d.tenant_id) AS assigned_count
       FROM payroll_component_definitions d
      WHERE d.id = $1 AND d.tenant_id = $2 AND d.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (!res.rows.length) throw notFound('Salary rule not found');
  return toCamelRow(res.rows[0]);
}

export async function createSalaryComponent(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const values = parseInput(input, false);
  if (!values.code || !values.name) throw badRequest('code and name are required');

  const cols = ['company_id', 'tenant_id', ...Object.keys(values)];
  const vals: unknown[] = [ctx.companyId, ctx.tenantId, ...Object.values(values)];
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `INSERT INTO payroll_component_definitions (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') {
      throw badRequest('A salary rule with this code already exists');
    }
    throw e;
  }
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'payroll_component_definitions',
    recordId: Number(row.id),
    recordCode: String(row.code),
    newValues: values,
  });
  return toCamelRow(row);
}

export async function updateSalaryComponent(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const values = parseInput(input, true);
  const keys = Object.keys(values);
  if (keys.length === 0) throw badRequest('No fields to update');
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals: unknown[] = [...keys.map((k) => values[k]), id, ctx.tenantId, ctx.companyId];
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `UPDATE payroll_component_definitions SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length - 2} AND tenant_id = $${vals.length - 1} AND company_id = $${vals.length}
       RETURNING *`,
      vals
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') {
      throw badRequest('A salary rule with this code already exists');
    }
    throw e;
  }
  if (res.rowCount === 0) throw notFound('Salary rule not found');
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'payroll_component_definitions',
    recordId: Number(row.id),
    recordCode: String(row.code),
    newValues: values,
  });
  return toCamelRow(row);
}
