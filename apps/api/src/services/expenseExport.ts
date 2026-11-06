import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import { logAudit } from './audit.js';

const EXPORT_COLUMNS: Array<[string, string]> = [
  ['Expense No', 'et.exp_no'], ['Date', 'et.exp_date'], ['Description', 'et.description'],
  ['Category', 'c.name'], ['Department', 'd.name'], ['Cost Centre', 'cc.name'],
  ['Payee', 'et.payee'], ['Supplier', 'su.name'], ['Employee', "TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, ''))"],
  ['Currency', 'et.currency'], ['Amount', 'et.amount'], ['Tax', 'et.tax_amount'],
  ['Status', 'et.status'], ['Payment Status', 'et.payment_status'], ['Reference', 'et.reference'],
  ['Payment Method', 'pm.name'], ['Project', 'p.name'], ['Risk', 'et.risk_level'],
];

function dateFilter(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw badRequest(`${name} must be a valid YYYY-MM-DD date`);
  }
  return result;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  // Prevent spreadsheet formula execution for untrusted text fields.
  if (/^[\s\u0000-\u001f]*[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportExpenses(client: pg.PoolClient, ctx: Ctx, filters: Record<string, unknown>) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const format = String(filters.format ?? 'csv').toLowerCase();
  if (!['csv', 'json'].includes(format)) throw badRequest('Expense export format must be csv or json');
  const from = dateFilter(filters.from, 'From date');
  const to = dateFilter(filters.to, 'To date');
  if (from && to && from > to) throw badRequest('From date must be on or before the to date');

  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['et.tenant_id = $1', 'et.company_id = $2'];
  const exactFilters: Array<[string, string]> = [
    ['status', 'et.status'], ['paymentStatus', 'et.payment_status'], ['departmentId', 'et.department_id'],
    ['costCentreId', 'et.cost_centre_id'], ['categoryId', 'et.category_id'], ['projectId', 'et.project_id'],
    ['supplierId', 'et.supplier_id'], ['employeeId', 'et.employee_id'],
  ];
  for (const [key, column] of exactFilters) {
    if (filters[key] === undefined || filters[key] === null || filters[key] === '') continue;
    const value = key.endsWith('Id') ? Number(filters[key]) : String(filters[key]).trim().toUpperCase();
    if (key.endsWith('Id') && (!Number.isInteger(value) || value <= 0)) throw badRequest(`${key} must be a positive integer`);
    params.push(value);
    where.push(`${column} = $${params.length}`);
  }
  for (const [key, op, value] of [['from', '>=', from], ['to', '<=', to]] as const) {
    if (value) {
      params.push(value);
      where.push(`et.exp_date ${op} $${params.length}`);
    }
  }
  if (filters.q != null && String(filters.q).trim()) {
    params.push(`%${String(filters.q).trim().slice(0, 120)}%`);
    where.push(`(et.exp_no ILIKE $${params.length} OR et.description ILIKE $${params.length} OR et.payee ILIKE $${params.length} OR et.reference ILIKE $${params.length} OR su.name ILIKE $${params.length})`);
  }
  const limit = Math.min(2000, Math.max(1, Number(filters.limit) || 1000));
  params.push(limit);
  const result = await client.query(
    `SELECT ${EXPORT_COLUMNS.map(([label, column]) => `${column} AS "${label}"`).join(', ')}
       FROM expense_transactions et
       LEFT JOIN expense_categories c ON c.id = et.category_id AND c.tenant_id = et.tenant_id AND c.company_id = et.company_id
       LEFT JOIN departments d ON d.id = et.department_id AND d.tenant_id = et.tenant_id AND d.company_id = et.company_id
       LEFT JOIN cost_centres cc ON cc.id = et.cost_centre_id AND cc.tenant_id = et.tenant_id AND cc.company_id = et.company_id
       LEFT JOIN suppliers su ON su.id = et.supplier_id AND su.tenant_id = et.tenant_id AND su.company_id = et.company_id
       LEFT JOIN employees e ON e.id = et.employee_id AND e.tenant_id = et.tenant_id AND e.company_id = et.company_id
       LEFT JOIN payment_methods pm ON pm.id = et.payment_method_id AND pm.tenant_id = et.tenant_id AND pm.company_id = et.company_id
       LEFT JOIN projects p ON p.id = et.project_id AND p.tenant_id = et.tenant_id AND p.company_id = et.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY et.exp_date DESC, et.id DESC LIMIT $${params.length}`,
    params
  );
  await logAudit(client, ctx, {
    action: 'export', resource: 'expenses', metadata: { format, rowCount: result.rows.length, limit, from, to },
  });
  if (format === 'json') return { format, rows: result.rows, rowCount: result.rows.length, limit };
  return {
    format,
    rowCount: result.rows.length,
    content: [EXPORT_COLUMNS.map(([label]) => csvCell(label)).join(','), ...result.rows.map((row) => EXPORT_COLUMNS.map(([label]) => csvCell(row[label])).join(','))].join('\r\n'),
  };
}
