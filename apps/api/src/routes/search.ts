import { Router } from 'express';
import { query } from '../db.js';
import { Ctx } from '../db.js';
import { asyncHandler, badRequest } from '../utils.js';

export const searchRouter = Router();

interface SearchTarget {
  table: string;
  label: string;
  columns: string[];
  permission: string;
}

const TARGETS: SearchTarget[] = [
  { table: 'customers', label: 'Customer', columns: ['name', 'email', 'phone', 'tin', 'code'], permission: 'crm.customers.view' },
  { table: 'suppliers', label: 'Supplier', columns: ['name', 'email', 'phone', 'tin', 'code'], permission: 'procurement.suppliers.view' },
  { table: 'products', label: 'Product', columns: ['code', 'name', 'description'], permission: 'inventory.items.view' },
  { table: 'employees', label: 'Employee', columns: ['employee_no', 'first_name', 'last_name', 'email'], permission: 'hr.employees.view' },
  { table: 'sales_quotations', label: 'Quotation', columns: ['quotation_no'], permission: 'sales.quotations.view' },
  { table: 'sales_orders', label: 'Sales Order', columns: ['order_no', 'customer_po_no'], permission: 'sales.orders.view' },
  { table: 'delivery_notes', label: 'Delivery Note', columns: ['delivery_no'], permission: 'sales.delivery_notes.view' },
  { table: 'customer_invoices', label: 'Invoice', columns: ['invoice_no'], permission: 'sales.invoices.view' },
  { table: 'receipts', label: 'Receipt', columns: ['receipt_no'], permission: 'sales.receipts.view' },
  { table: 'credit_notes', label: 'Credit Note', columns: ['credit_no'], permission: 'sales.credit_notes.view' },
  { table: 'debit_notes', label: 'Debit Note', columns: ['debit_no'], permission: 'sales.debit_notes.view' },
  { table: 'purchase_requisitions', label: 'Purchase Requisition', columns: ['pr_no'], permission: 'procurement.requisitions.view' },
  { table: 'purchase_orders', label: 'Purchase Order', columns: ['po_no'], permission: 'procurement.orders.view' },
  { table: 'goods_receipts', label: 'Goods Receipt', columns: ['grn_no', 'delivery_ref'], permission: 'procurement.goods_receipts.view' },
  { table: 'supplier_invoices', label: 'Supplier Invoice', columns: ['supplier_invoice_no'], permission: 'procurement.supplier_invoices.view' },
  { table: 'supplier_payments', label: 'Supplier Payment', columns: ['payment_no'], permission: 'procurement.payments.view' },
  { table: 'purchase_returns', label: 'Supplier Return', columns: ['return_no'], permission: 'procurement.returns.view' },
  { table: 'work_orders', label: 'Work Order', columns: ['wo_no'], permission: 'production.work_orders.view' },
  { table: 'production_plans', label: 'Production Plan', columns: ['plan_no'], permission: 'production.plans.view' },
  { table: 'product_batches', label: 'Batch', columns: ['batch_no'], permission: 'inventory.batches.view' },
  { table: 'machines', label: 'Machine', columns: ['code', 'name'], permission: 'production.machines.view' },
  { table: 'asset_register', label: 'Asset', columns: ['asset_no', 'name', 'serial_no', 'barcode'], permission: 'assets.register.view' },
  { table: 'qr_codes', label: 'QR Code', columns: ['code'], permission: 'qr.codes.view' },
  { table: 'documents', label: 'Document', columns: ['doc_no', 'title'], permission: 'documents.documents.view' },
  { table: 'security_jobs', label: 'Security Job', columns: ['job_no'], permission: 'security_printing.jobs.view' },
  { table: 'payrolls', label: 'Payroll', columns: ['payroll_no'], permission: 'hr.payrolls.view' },
];

function hasPermission(userPerms: string[], required: string): boolean {
  if (userPerms.includes('system.admin.all')) return true;
  const [m, r] = required.split('.');
  return (
    userPerms.includes(required) ||
    userPerms.includes(`${m}.${r}.*`) ||
    userPerms.includes(`${m}.*`) ||
    userPerms.includes('*')
  );
}

/** Cache of column names per table (lazy, schema is static in production). */
const tableColumns = new Map<string, Promise<Set<string>>>();

function getColumns(table: string, ctx: Ctx): Promise<Set<string>> {
  let p = tableColumns.get(table);
  if (!p) {
    p = query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table],
      ctx
    )
      .then((r) => new Set(r.rows.map((row) => String(row.column_name))))
      .catch((err) => {
        tableColumns.delete(table);
        throw err;
      });
    tableColumns.set(table, p);
  }
  return p;
}

/** Build a tenant-safe scope predicate using only columns that exist on the table. */
async function dynamicScope(table: string, ctx: Ctx): Promise<string> {
  const cols = await getColumns(table, ctx);
  const conds: string[] = [];
  if (cols.has('company_id') && ctx.companyId) conds.push(`t.company_id = ${ctx.companyId}`);
  if (cols.has('branch_id') && ctx.branchId) conds.push(`t.branch_id = ${ctx.branchId}`);
  return conds.length ? conds.join(' AND ') : '1=1';
}

searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) throw badRequest('Search query must be at least 2 characters');
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const out: { label: string; table: string; matches: Record<string, unknown>[] }[] = [];
    const perms = req.auth!.permissions;

    for (const target of TARGETS) {
      if (!hasPermission(perms, target.permission)) continue;
      const scope = await dynamicScope(target.table, req.ctx);
      const ors = target.columns.map((c) => `t.${c}::text ILIKE $1`);
      const sql = `SELECT t.* FROM ${target.table} t WHERE (${ors.join(' OR ')}) AND ${scope} ORDER BY t.id DESC LIMIT $2`;
      const res2 = await query(sql, [`%${q}%`, limit], req.ctx);
      if (res2.rows.length > 0) {
        out.push({ label: target.label, table: target.table, matches: res2.rows as unknown as Record<string, unknown>[] });
      }
    }
    res.json({ data: out, query: q });
  })
);
