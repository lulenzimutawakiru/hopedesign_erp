import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import * as expenses from './expenses.js';

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${label} is required`);
  return id;
}

function validDate(value: unknown): string {
  const date = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw badRequest('Expense date must be a valid YYYY-MM-DD date');
  }
  return date;
}

async function validateClaimReferences(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const employeeId = positiveId(body.employeeId, 'Employee');
  const employee = await client.query(
    `SELECT id FROM employees
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND status = 'ACTIVE'
      LIMIT 1`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (!employee.rows.length) throw badRequest('Employee must be active in the current company');

  const paymentMethodId = body.paymentMethodId;
  if (paymentMethodId !== undefined && paymentMethodId !== null && paymentMethodId !== '') {
    const id = positiveId(paymentMethodId, 'Payment method');
    const method = await client.query(
      `SELECT id FROM payment_methods
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND is_active = true
        LIMIT 1`,
      [id, ctx.tenantId, ctx.companyId]
    );
    if (!method.rows.length) throw badRequest('Payment method must be active in the current company');
  }
}

/** Validate employee reimbursement claims before creating immutable workflow records. */
export async function createClaim(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Claim amount must be greater than zero');
  validDate(body.expenseDate);
  if (typeof body.description !== 'string' || !body.description.trim()) throw badRequest('Claim description is required');
  await validateClaimReferences(client, ctx, body);
  return expenses.createClaim(client, ctx, { ...body, amount: Math.round(amount * 100) / 100 });
}

export async function submitClaim(client: pg.PoolClient, ctx: Ctx, id: number) {
  const claim = await expenses.getClaim(client, ctx, id);
  if (!claim.employeeId || !Number(claim.amount) || !String(claim.description ?? '').trim()) {
    throw badRequest('Complete the employee, description, and positive amount before submitting');
  }
  return expenses.submitClaim(client, ctx, id);
}
