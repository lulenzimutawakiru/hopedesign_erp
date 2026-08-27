import { query } from '../db.js';

/** Registered management reports. Every report maps to a database view and a
 *  permission gate. Nothing outside this registry can be executed by the
 *  reports API, the scheduler, or saved-view filters. */
export interface ReportDef {
  name: string;
  table: string;
  permission: string;
  label: string;
}

export const REPORTS: ReportDef[] = [
  { name: 'inventory-summary', table: 'v_inventory_summary', permission: 'reports.inventory.view', label: 'Inventory Summary' },
  { name: 'stock-value', table: 'v_stock_value', permission: 'reports.inventory.view', label: 'Stock Value' },
  { name: 'trial-balance', table: 'v_trial_balance', permission: 'reports.finance.view', label: 'Trial Balance' },
  { name: 'ar-aging', table: 'v_ar_aging', permission: 'reports.finance.view', label: 'Accounts Receivable Aging' },
  { name: 'ap-aging', table: 'v_ap_aging', permission: 'reports.finance.view', label: 'Accounts Payable Aging' },
  { name: 'sales-by-month', table: 'v_sales_by_month', permission: 'reports.sales.view', label: 'Sales by Month' },
  { name: 'production-yield', table: 'v_production_yield_by_month', permission: 'reports.production.view', label: 'Production Yield by Month' },
  { name: 'work-order-summary', table: 'v_work_order_summary', permission: 'reports.production.view', label: 'Work Order Summary' },
  { name: 'qr-lineage', table: 'v_qr_lineage', permission: 'reports.qr.view', label: 'QR Lineage' },
  { name: 'payroll-register', table: 'v_payroll_register', permission: 'reports.hr.view', label: 'Payroll Register' },
  { name: 'payroll-summary', table: 'v_payroll_summary', permission: 'reports.hr.view', label: 'Payroll Summary' },
  { name: 'payroll-statutory', table: 'v_payroll_statutory', permission: 'reports.hr.view', label: 'Statutory Report' },
  { name: 'payroll-earnings', table: 'v_payroll_earnings', permission: 'reports.hr.view', label: 'Earnings Report' },
  { name: 'payroll-deductions', table: 'v_payroll_deductions', permission: 'reports.hr.view', label: 'Deductions Report' },
  { name: 'payslip-register', table: 'v_payslip_register', permission: 'reports.hr.view', label: 'Payslip Register' },
];

/** Additional table sources safe for the KPI engine and custom report
 *  builder. Views from REPORTS plus base tables that carry tenant/company
 *  scope columns. Nothing outside this registry can be queried. */
export const ANALYTICS_SOURCES: string[] = [
  ...new Set([...REPORTS.map((r) => r.table), 'work_orders', 'qr_scans', 'inventory', 'delivery_notes', 'trips', 'vehicles']),
];

const columnCache = new Map<string, string[]>();

export async function columnsOf(table: string): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const res = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  const cols = res.rows.map((r) => String(r.column_name));
  columnCache.set(table, cols);
  return cols;
}

/** Keep only columns that actually exist on the report view (prevents any
 *  user-supplied column name from reaching the SQL). */
export async function sanitizeFilters(def: ReportDef, raw: unknown): Promise<Record<string, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cols = await columnsOf(def.table);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const col = k.replace(/[A-Z]/g, (m: string) => '_' + m.toLowerCase());
    if (!cols.includes(col)) continue;
    if (v === null || v === undefined || v === '') continue;
    out[col] = String(v);
  }
  return out;
}

export function buildWhere(
  cols: string[],
  filters: Record<string, unknown>,
  companyId: number | null | undefined
): { where: string[]; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = [];
  if (companyId) {
    params.push(companyId);
    where.push(`company_id = $${params.length}`);
  } else if (cols.includes('company_id')) {
    where.push('company_id IS NOT NULL');
  }
  for (const [k, v] of Object.entries(filters ?? {})) {
    const col = k.replace(/[A-Z]/g, (m: string) => '_' + m.toLowerCase());
    if (!cols.includes(col)) continue;
    if (v === null || v === undefined || v === '') continue;
    params.push(v);
    where.push(`${col} = $${params.length}`);
  }
  return { where, params };
}

export function buildReportSql(
  def: ReportDef,
  cols: string[],
  filters: Record<string, unknown>,
  companyId: number | null | undefined,
  limit = 1000
): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(cols, filters, companyId);
  const sql = `SELECT * FROM ${def.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY 1 LIMIT ${limit}`;
  return { sql, params };
}

export function buildCountSql(
  def: ReportDef,
  cols: string[],
  filters: Record<string, unknown>,
  companyId: number | null | undefined
): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(cols, filters, companyId);
  const sql = `SELECT count(*)::int AS total FROM ${def.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return { sql, params };
}

/** Numeric columns worth summing in a report summary. */
export function summableColumns(cols: string[]): string[] {
  return cols.filter(
    (c) => /(amount|total|value|balance|cost|qty|quantity|revenue|net|gross|price|rate|premium)/i.test(c) && !c.endsWith('_id')
  );
}

export function reportDef(name: string): ReportDef | undefined {
  return REPORTS.find((r) => r.name === String(name ?? '').toLowerCase());
}
