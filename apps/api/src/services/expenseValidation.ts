import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound } from '../utils.js';
import * as expenses from './expenses.js';

const round2 = (value: number) => Math.round(value * 100) / 100;
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Validate the expense payload before it reaches persistence. Keep this pure so the rules are easy to test. */
export function validateExpenseInput(body: Record<string, unknown>, partial = false): void {
  if (!partial || 'description' in body) {
    if (typeof body.description !== 'string' || !body.description.trim()) throw badRequest('Description is required');
  }
  if (!partial || 'amount' in body) {
    const amount = numberOrNull(body.amount);
    if (amount === null || amount <= 0) throw badRequest('Amount must be greater than zero');
  }
  if (!partial || 'categoryId' in body) {
    const categoryId = numberOrNull(body.categoryId);
    if (categoryId === null || !Number.isInteger(categoryId) || categoryId <= 0) throw badRequest('A valid expense category is required');
  }
  for (const field of ['amount', 'taxAmount'] as const) {
    if (field in body && body[field] !== undefined) {
      const value = numberOrNull(body[field]);
      if (value === null || value < 0) throw badRequest(`${field === 'taxAmount' ? 'Tax amount' : 'Amount'} must be a non-negative number`);
    }
  }
  const amount = numberOrNull(body.amount);
  const tax = numberOrNull(body.taxAmount);
  if (amount !== null && tax !== null && tax > amount) throw badRequest('Tax amount cannot exceed the expense total');
  if ('currency' in body && body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency.trim()))) {
    throw badRequest('Currency must be a three-letter ISO code');
  }
  if ('lines' in body && body.lines !== undefined) {
    if (!Array.isArray(body.lines)) throw badRequest('Expense lines must be a list');
    if (body.lines.length > 100) throw badRequest('An expense may contain no more than 100 lines');
    for (const [index, raw] of body.lines.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`Expense line ${index + 1} is invalid`);
      const line = raw as Record<string, unknown>;
      if (typeof line.description !== 'string' || !line.description.trim()) throw badRequest(`Description is required for expense line ${index + 1}`);
      const quantity = numberOrNull(line.quantity ?? 1);
      const unitCost = numberOrNull(line.unitCost ?? 0);
      const lineAmount = numberOrNull(line.amount);
      if (quantity === null || quantity <= 0) throw badRequest(`Quantity for expense line ${index + 1} must be greater than zero`);
      if (unitCost === null || unitCost < 0) throw badRequest(`Unit cost for expense line ${index + 1} must be non-negative`);
      if (lineAmount !== null && lineAmount < 0) throw badRequest(`Amount for expense line ${index + 1} must be non-negative`);
      if (lineAmount !== null && Math.abs(lineAmount - round2(quantity * unitCost)) > 0.01) {
        throw badRequest(`Expense line ${index + 1} amount must equal quantity multiplied by unit cost`);
      }
    }
  }
}

const OWNED_REFERENCES: Record<string, { table: string; active?: string }> = {
  categoryId: { table: 'expense_categories', active: 'is_active = true' },
  departmentId: { table: 'departments', active: "status = 'ACTIVE'" },
  costCentreId: { table: 'cost_centres', active: "status = 'ACTIVE'" },
  projectId: { table: 'projects', active: "status = 'ACTIVE'" },
  employeeId: { table: 'employees', active: "status = 'ACTIVE'" },
  supplierId: { table: 'suppliers', active: "status = 'ACTIVE'" },
  paymentMethodId: { table: 'payment_methods', active: 'is_active = true' },
  budgetId: { table: 'budgets' },
  accountId: { table: 'chart_of_accounts' },
  requisitionId: { table: 'requisitions' },
  duplicateOfId: { table: 'expense_transactions' },
};

async function validateReferences(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>): Promise<void> {
  for (const [field, spec] of Object.entries(OWNED_REFERENCES)) {
    if (!(field in body) || body[field] === null || body[field] === '') continue;
    const id = numberOrNull(body[field]);
    if (id === null || !Number.isInteger(id) || id <= 0) throw badRequest(`${field} must be a valid record id`);
    const active = spec.active ? ` AND ${spec.active}` : '';
    const result = await client.query(
      `SELECT id FROM ${spec.table} WHERE id = $1 AND tenant_id = $2 AND company_id = $3${active} LIMIT 1`,
      [id, ctx.tenantId, ctx.companyId]
    );
    if (!result.rows.length) throw badRequest(`${field} does not identify an active record in this company`);
  }
}

export async function createExpense(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  validateExpenseInput(body);
  await validateReferences(client, ctx, body);
  return expenses.createExpense(client, ctx, body);
}

export async function updateExpense(client: pg.PoolClient, ctx: Ctx, id: number, body: Record<string, unknown>) {
  validateExpenseInput(body, true);
  await validateReferences(client, ctx, body);
  return expenses.updateExpense(client, ctx, id, body);
}

export async function submitExpense(client: pg.PoolClient, ctx: Ctx, id: number) {
  const expense = await expenses.getExpense(client, ctx, id);
  if (!String(expense.description ?? '').trim() || Number(expense.amount) <= 0 || !expense.categoryId) {
    throw badRequest('Complete the description, category, and positive total before submitting');
  }
  const lines = Array.isArray(expense.lines) ? expense.lines as Array<Record<string, unknown>> : [];
  if (lines.length) {
    const linesTotal = round2(lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
    if (Math.abs(linesTotal - Number(expense.amount)) > 0.01) {
      throw badRequest('Expense lines must add up to the expense total', { linesTotal, expenseTotal: Number(expense.amount) });
    }
  }
  return expenses.submitExpense(client, ctx, id);
}

const RECEIPT_REFERENCE_TABLES: Record<string, string> = {
  EXPENSE: 'expense_transactions',
  CLAIM: 'employee_expense_claims',
  REQUISITION: 'requisitions',
  REPLENISHMENT: 'petty_cash_replenishments',
  SUPPLIER_INVOICE: 'supplier_invoices',
  PAYMENT: 'payment_requests',
};

/** Validate the target and storage key before the underlying upload writes any bytes. */
export async function uploadReceipt(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const refType = String(body.refType ?? '').toUpperCase();
  const refId = numberOrNull(body.refId);
  const table = RECEIPT_REFERENCE_TABLES[refType];
  if (!table || refId === null || !Number.isInteger(refId) || refId <= 0) throw badRequest('A valid receipt reference is required');
  const found = await client.query(
    `SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2 AND company_id = $3 LIMIT 1`,
    [refId, ctx.tenantId, ctx.companyId]
  );
  if (!found.rows.length) throw notFound('Receipt target not found');
  const key = body.storageKey;
  if (typeof key === 'string' && (key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => part === '..' || part === '.'))) {
    throw badRequest('Invalid receipt storage key');
  }
  return expenses.uploadReceipt(client, ctx, body);
}
