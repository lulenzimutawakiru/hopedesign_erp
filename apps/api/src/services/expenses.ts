import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, forbidden, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow } from './workflow.js';
import * as finance from './finance.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { createNotification, notifyRole } from './notifications.js';

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

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

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

async function projects(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM projects
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY name`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function employees(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, employee_no, first_name, last_name, (first_name || ' ' || last_name) AS name
     FROM employees
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY first_name LIMIT 500`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function suppliers(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM suppliers
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY name LIMIT 500`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

async function budgets(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT b.id, b.budget_no, b.budget_no AS name, b.period_start, b.period_end,
            COALESCE((SELECT SUM(bl.amount) FROM budget_lines bl WHERE bl.budget_id = b.id), 0)::numeric AS amount
     FROM budgets b
     WHERE b.company_id = $1 AND b.tenant_id = $2 AND b.status IN ('APPROVED','ACTIVE')
     ORDER BY b.period_start DESC LIMIT 100`,
    [companyId(ctx), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

/** Form metadata: categories, payment channels, departments, centres, projects, employees, suppliers, funds, budgets. */
export async function expenseMeta(client: pg.PoolClient, ctx: Ctx) {
  const [cats, methods, depts, centres, projs, emps, sups, funds, bdgs] = await Promise.all([
    client.query(
      `SELECT c.id, c.code, c.name, c.category_group, c.account_id, a.code AS account_code,
              a.name AS account_name, c.description, c.is_active
       FROM expense_categories c LEFT JOIN chart_of_accounts a ON a.id = c.account_id
       WHERE c.company_id = $1 AND c.tenant_id = $2 AND c.is_active = true
       ORDER BY c.category_group, c.name`,
      [companyId(ctx), ctx.tenantId]
    ),
    client.query(
      `SELECT id, code, name, method_type, channel, bank_account_id, is_active
       FROM payment_methods
       WHERE company_id = $1 AND tenant_id = $2 AND is_active = true
       ORDER BY name`,
      [companyId(ctx), ctx.tenantId]
    ),
    departments(client, ctx),
    costCentres(client, ctx),
    projects(client, ctx),
    employees(client, ctx),
    suppliers(client, ctx),
    client.query(
      `SELECT id, code, name, custodian_user_id, currency, float_amount, opening_balance, status
       FROM petty_cash_funds
       WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
       ORDER BY name`,
      [companyId(ctx), ctx.tenantId]
    ),
    budgets(client, ctx),
  ]);
  return {
    categories: toCamelRows(cats.rows),
    paymentMethods: toCamelRows(methods.rows),
    departments: depts,
    costCentres: centres,
    projects: projs,
    employees: emps,
    suppliers: sups,
    pettyCashFunds: toCamelRows(funds.rows),
    budgets: bdgs,
  };
}

/** Possible-duplicate scan: same supplier + invoice + amount, or a hash match. */
export async function duplicateScan(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const supplierId = n(input.supplierId);
  const invoiceNo = s(input.invoiceNo);
  const amount = num0(input.amount);
  const expDate = isoDate(input.expDate);
  const contentHash = s(input.contentHash);
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['et.tenant_id = $1', 'et.company_id = $2', "et.status IN ('SUBMITTED','APPROVED','PAID','POSTED')"];
  if (supplierId != null) {
    params.push(supplierId);
    where.push(`et.supplier_id = $${params.length}`);
  }
  if (invoiceNo) {
    params.push(invoiceNo);
    where.push(`et.reference = $${params.length}`);
  }
  if (amount > 0) {
    params.push(amount);
    where.push(`et.amount = $${params.length}`);
  }
  if (expDate) {
    params.push(expDate);
    where.push(`et.exp_date = $${params.length}`);
  }
  const rows = await client.query(
    `SELECT et.id, et.exp_no, et.exp_date, et.amount, et.payee, et.supplier_id, et.reference,
            su.name AS supplier_name, et.status
     FROM expense_transactions et
     LEFT JOIN suppliers su ON su.id = et.supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY et.exp_date DESC, et.id DESC LIMIT 10`,
    params
  );
  const hashMatches: Array<Record<string, unknown>> = [];
  if (contentHash) {
    const hr = await client.query(
      `SELECT er.id, er.ref_type, er.ref_id, er.file_name, er.content_hash, er.invoice_no, er.total,
              et.exp_no, et.amount, et.exp_date
       FROM expense_receipts er
       LEFT JOIN expense_transactions et ON et.id = er.ref_id AND er.ref_type = 'EXPENSE'
       WHERE er.tenant_id = $1 AND er.content_hash = $2 AND er.verified = true
       ORDER BY er.id DESC LIMIT 10`,
      [ctx.tenantId, contentHash]
    );
    hashMatches.push(...toCamelRows(hr.rows));
  }
  return {
    matches: toCamelRows(rows.rows),
    hashMatches,
    possibleDuplicate: rows.rows.length > 0 || hashMatches.length > 0,
  };
}

/** Risk flags for an expenditure: weekend, no receipt, high-value petty cash, duplicate, over-budget, repeated emergency. */
export async function riskEngineForExpense(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const flags: string[] = [];
  let score = 0;
  const amount = num0(input.amount);
  const expDate = isoDate(input.expDate);
  const day = expDate ? new Date(`${expDate}T00:00:00`).getDay() : new Date().getDay();
  if (day === 0 || day === 6) {
    flags.push('Weekend expenditure');
    score += 20;
  }
  if (amount >= 1000000 && String(input.paymentMethodType ?? input.paymentMethod).toUpperCase().includes('PETTY')) {
    flags.push('High-value petty cash');
    score += 20;
  }
  if (input.supplierId != null || input.reference) {
    const dup = await duplicateScan(client, ctx, input);
    if (dup.possibleDuplicate) {
      flags.push('Possible duplicate expense');
      score += 35;
    }
  }
  if (!input.receiptUploaded && !input.hasReceipt) {
    flags.push('Expense without receipt');
    score += 15;
  }
  if (input.isEmergency === true || input.isEmergency === 'true' || input.isPlanned === false || input.isPlanned === 'false') {
    flags.push('Unplanned / emergency expense');
    score += 10;
  }
  if (input.accountId != null) {
    try {
      const pos = await finance.budgetPosition(client, ctx, Number(input.accountId));
      if (pos.available < amount) {
        flags.push('Over budget');
        score += 25;
      }
    } catch {
      /* budget lookup is advisory; never block on it here */
    }
  }
  const level = score >= 60 ? 'CRITICAL' : score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';
  return { score, level, flags, riskFlags: flags };
}

export async function createExpense(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const company = companyId(ctx);
  if (!s(b.description)) throw badRequest('Description is required');
  const amount = num0(b.amount);
  if (amount <= 0) throw badRequest('Amount must be greater than zero');
  const categoryId = n(b.categoryId);
  if (categoryId == null) throw badRequest('Expense category is required');
  const expNo = await nextDoc(client, ctx, 'EXP');
  const accountId = n(b.accountId);
  const paymentMethodId = n(b.paymentMethodId);
  const methodType = s(b.paymentMethodType);
  const risk = await riskEngineForExpense(client, ctx, {
    amount,
    expDate: b.expDate,
    supplierId: b.supplierId,
    reference: b.reference,
    paymentMethodType: methodType,
    accountId,
    receiptUploaded: b.hasReceipt === true || b.hasReceipt === 'true',
    isPlanned: b.isPlanned,
  });
  const dup = b.duplicateOfId != null ? n(b.duplicateOfId) : null;
  const ins = await client.query(
    `INSERT INTO expense_transactions
       (company_id, tenant_id, branch_id, exp_no, exp_date, department_id, cost_centre_id, category_id,
        description, amount, currency, payment_method_id, payee, supplier_id, employee_id, project_id,
        budget_id, account_id, tax_id, tax_amount, vehicle, receipt_ref, reference, is_planned,
        requisition_id, duplicate_of_id, risk_score, risk_level, risk_flags, status, payment_status,
        accounting_status, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'DRAFT','UNPAID','UNPOSTED',$30,$30)
     RETURNING id`,
    [company, ctx.tenantId, ctx.branchId ?? null, expNo, isoDate(b.expDate), n(b.departmentId), n(b.costCentreId),
     categoryId, s(b.description), round2(amount), s(b.currency) ?? 'UGX', paymentMethodId, s(b.payee),
     n(b.supplierId), n(b.employeeId), n(b.projectId), n(b.budgetId), accountId, n(b.taxId), round2(num0(b.taxAmount)),
     s(b.vehicle), s(b.receiptRef), s(b.reference), b.isPlanned === true || b.isPlanned === 'true',
     n(b.requisitionId), dup, risk.score, risk.level, JSON.stringify(risk.flags), ctx.userId ?? null]
  );
  const expenseId = Number(ins.rows[0].id);
  if (Array.isArray(b.lines)) {
    let lineNo = 1;
    for (const line of b.lines as Array<Record<string, unknown>>) {
      await client.query(
        `INSERT INTO expense_lines
           (expense_transaction_id, tenant_id, line_no, description, category_id, account_id,
            cost_centre_id, project_id, quantity, unit_cost, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [expenseId, ctx.tenantId, lineNo, s(line.description) ?? s(b.description), n(line.categoryId) ?? categoryId,
         n(line.accountId) ?? accountId, n(line.costCentreId) ?? n(b.costCentreId), n(line.projectId) ?? n(b.projectId),
         num0(line.quantity) || 1, num0(line.unitCost), round2(num0(line.amount) || num0(line.quantity) * num0(line.unitCost) || amount)]
      );
      lineNo += 1;
    }
  }
  await logAudit(client, ctx, { action: 'create', resource: 'expenses', recordId: expenseId, recordCode: expNo, newValues: { amount, categoryId, risk } });
  await emitEvent(client, ctx, { eventType: 'expense.created', entityType: 'ops.expenses', entityId: expenseId, entityCode: expNo, payload: { amount, risk: risk.level } });
  return getExpense(client, ctx, expenseId);
}

const EXPENSE_EDIT = {
  description: 'description', amount: 'amount', expDate: 'exp_date', currency: 'currency',
  departmentId: 'department_id', costCentreId: 'cost_centre_id', categoryId: 'category_id',
  paymentMethodId: 'payment_method_id', payee: 'payee', supplierId: 'supplier_id',
  employeeId: 'employee_id', projectId: 'project_id', budgetId: 'budget_id', accountId: 'account_id',
  taxId: 'tax_id', taxAmount: 'tax_amount', vehicle: 'vehicle', receiptRef: 'receipt_ref',
  reference: 'reference', isPlanned: 'is_planned',
} as const;

export async function updateExpense(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const cur = await getExpense(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft expenses can be edited (current: ${cur.status})`);
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };
  for (const [camel, col] of Object.entries(EXPENSE_EDIT)) {
    if (camel in b) push(col, col === 'amount' || col === 'tax_amount' ? round2(num0(b[camel])) : col === 'is_planned' ? b[camel] === true || b[camel] === 'true' : col === 'exp_date' ? isoDate(b[camel]) : n(b[camel]) ?? s(b[camel]));
  }
  if (sets.length === 0) return cur;
  params.push(ctx.userId ?? null, id);
  await client.query(`UPDATE expense_transactions SET ${sets.join(', ')}, updated_by = $${params.length - 1} WHERE id = $${params.length}`, params);
  if (Array.isArray(b.lines)) {
    await client.query(`DELETE FROM expense_lines WHERE expense_transaction_id = $1`, [id]);
    let lineNo = 1;
    for (const line of b.lines as Array<Record<string, unknown>>) {
      await client.query(
        `INSERT INTO expense_lines
           (expense_transaction_id, tenant_id, line_no, description, category_id, account_id,
            cost_centre_id, project_id, quantity, unit_cost, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, ctx.tenantId, lineNo, s(line.description) ?? String(cur.description), n(line.categoryId) ?? n(b.categoryId),
         n(line.accountId) ?? n(b.accountId), n(line.costCentreId) ?? n(b.costCentreId), n(line.projectId) ?? n(b.projectId),
         num0(line.quantity) || 1, num0(line.unitCost), round2(num0(line.amount) || num0(line.quantity) * num0(line.unitCost))]
      );
      lineNo += 1;
    }
  }
  await logAudit(client, ctx, { action: 'update', resource: 'expenses', recordId: id, recordCode: String(cur.expNo), oldValues: changes, newValues: changes });
  return getExpense(client, ctx, id);
}

export async function submitExpense(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getExpense(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft expenses can be submitted (current: ${cur.status})`);
  const amount = num0(cur.amount);
  const accountId = cur.accountId != null ? Number(cur.accountId) : null;
  if (accountId) {
    const pos = await finance.budgetPosition(client, ctx, accountId);
    if (pos.available < amount) {
      throw badRequest(
        `Expense exceeds available budget (available ${pos.available.toLocaleString()}, amount ${amount.toLocaleString()})`,
        pos
      );
    }
  }
  await client.query(
    `UPDATE expense_transactions SET status = 'SUBMITTED', updated_by = $1 WHERE id = $2`,
    [ctx.userId ?? null, id]
  );
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.expenses', entityId: id, entityCode: String(cur.expNo), amount,
    companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.expenses',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.expNo), ctx.userId ?? null, JSON.stringify({ amount, instanceId })]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'expenses', recordId: id, recordCode: String(cur.expNo), newValues: { status: 'SUBMITTED', amount } });
  await emitEvent(client, ctx, { eventType: 'expense.submitted', entityType: 'ops.expenses', entityId: id, entityCode: String(cur.expNo), payload: { amount } });
  return getExpense(client, ctx, id);
}

export async function payExpense(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const cur = await getExpense(client, ctx, id);
  if (!['APPROVED', 'POSTED'].includes(String(cur.status))) {
    throw badRequest(`Only approved expenses can be paid (current: ${cur.status})`);
  }
  if (String(cur.paymentStatus) === 'PAID') throw badRequest('Expense is already paid');
  const payNo = await nextDoc(client, ctx, 'PAY');
  const payeeType = cur.supplierId != null ? 'SUPPLIER' : cur.employeeId != null ? 'EMPLOYEE' : 'OTHER';
  const paymentMethodId = n(b.paymentMethodId) ?? n(cur.paymentMethodId);
  const payRes = await client.query(
    `INSERT INTO payment_requests
       (company_id, tenant_id, branch_id, pay_no, ref_type, ref_id, ref_code, payee, payee_type,
        amount, currency, payment_method_id, bank_account_id, reference, status, requested_by, paid_by, paid_at, gl_posted)
     VALUES ($1,$2,$3,$4,'EXPENSE',$5,$6,$7,$8,$9,$10,$11,$12,$13,'PAID',$14,$15,now(),false)
     RETURNING id`,
    [companyId(ctx), ctx.tenantId, ctx.branchId ?? null, payNo, id, String(cur.expNo),
     s(b.payee) ?? s(cur.payee) ?? s(cur.payee) ?? null, payeeType, round2(num0(cur.amount)),
     s(cur.currency) ?? 'UGX', paymentMethodId, n(b.bankAccountId) ?? n(cur.bankAccountId) ?? null,
     s(b.reference) ?? s(cur.reference), ctx.userId ?? null, ctx.userId ?? null]
  );
  await client.query(
    `UPDATE expense_transactions
        SET payment_status = 'PAID', status = 'PAID', paid_by = $1, paid_at = now(), payment_method_id = COALESCE($2, payment_method_id), updated_by = $1
      WHERE id = $3`,
    [ctx.userId ?? null, paymentMethodId, id]
  );
  await logAudit(client, ctx, { action: 'pay', resource: 'expenses', recordId: id, recordCode: String(cur.expNo), newValues: { payNo, status: 'PAID', paymentStatus: 'PAID' } });
  await emitEvent(client, ctx, { eventType: 'expense.paid', entityType: 'ops.expenses', entityId: id, entityCode: String(cur.expNo), payload: { payNo, amount: num0(cur.amount) } });
  await createNotification(client, ctx, {
    userId: cur.createdBy != null ? Number(cur.createdBy) : 0, type: 'PAYMENT_CONFIRMED',
    title: `Payment recorded ${cur.expNo}`, body: `${cur.expNo} paid ${num0(cur.amount).toLocaleString()}`,
    entityType: 'ops.expenses', entityId: id, actionRequired: false, severity: 'SUCCESS',
  });
  return { payId: Number(payRes.rows[0].id), payNo, status: 'PAID' };
}

/** Map a payment method type to the credit side of the expense journal. */
function creditAccountForMethod(methodType: string | null | undefined, paymentMethodId: number | null): string {
  const t = String(methodType ?? '').toUpperCase();
  if (t.includes('BANK') || t.includes('CARD')) return '1100';
  if (t.includes('CREDIT') || t.includes('DIRECT_SUPPLIER')) return '2100';
  if (t.includes('MOBILE')) return '1200';
  if (t.includes('PETTY')) return '1200';
  if (t.includes('REIMBURS')) return '1200';
  if (paymentMethodId != null) return '1200';
  return '1200';
}

export async function postExpense(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getExpense(client, ctx, id);
  if (!['APPROVED', 'PAID'].includes(String(cur.status))) {
    throw badRequest(`Only approved/paid expenses can be posted (current: ${cur.status})`);
  }
  if (String(cur.accountingStatus) === 'POSTED') throw badRequest('Expense is already posted');
  const amount = num0(cur.amount);
  const taxAmount = round2(num0(cur.taxAmount));
  const expenseAccountId = cur.accountId != null ? Number(cur.accountId) : cur.categoryAccountId != null ? Number(cur.categoryAccountId) : null;
  const expenseAccount = expenseAccountId ?? (await finance.getAccountId(client, ctx, '6100'));
  const creditCode = creditAccountForMethod(String(cur.paymentMethodType ?? ''), cur.paymentMethodId != null ? Number(cur.paymentMethodId) : null);
  const creditAccount = await finance.getAccountId(client, ctx, creditCode);
  const lines: finance.JournalLine[] = [
    {
      account_id: expenseAccount, debit: round2(amount - taxAmount), credit: 0,
      cost_centre_id: cur.costCentreId != null ? Number(cur.costCentreId) : null,
      description: String(cur.description),
    },
  ];
  if (taxAmount > 0) {
    const vat = await finance.getAccountId(client, ctx, '2110');
    lines.push({ account_id: vat, debit: taxAmount, credit: 0, description: `Input VAT ${cur.expNo}` });
  }
  lines.push({ account_id: creditAccount, debit: 0, credit: round2(amount), description: `Payment ${cur.expNo}` });
  const journalId = await finance.postJournalLines(client, ctx, {
    entryDate: isoDate(cur.expDate),
    journalType: 'EXPENSE',
    description: `Expense ${cur.expNo} - ${String(cur.description)}`,
    lines,
    refType: 'expense', refId: id, refCode: String(cur.expNo),
    currency: s(cur.currency) ?? 'UGX',
  });
  // Immutability guard only permits PAID/POSTED -> VOID status transitions,
  // so keep a PAID expense at PAID and only flip the accounting flags.
  const postedStatus = String(cur.status) === 'PAID' ? 'PAID' : 'POSTED';
  await client.query(
    `UPDATE expense_transactions
        SET status = $4, accounting_status = 'POSTED', gl_posted = true, gl_journal_id = $1,
            posted_by = $2, posted_at = now(), updated_by = $2
      WHERE id = $3`,
    [journalId, ctx.userId ?? null, id, postedStatus]
  );
  await client.query(
    `INSERT INTO financial_postings (company_id, tenant_id, ref_type, ref_id, ref_code, journal_id, posting_type, amount, posted_by)
     VALUES ($1,$2,'EXPENSE',$3,$4,$5,'EXPENSE',$6,$7)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.expNo), journalId, round2(amount), ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'post', resource: 'expenses', recordId: id, recordCode: String(cur.expNo), newValues: { journalId, status: 'POSTED', accountingStatus: 'POSTED' } });
  await emitEvent(client, ctx, { eventType: 'expense.posted', entityType: 'ops.expenses', entityId: id, entityCode: String(cur.expNo), payload: { journalId, amount } });
  return getExpense(client, ctx, id);
}

export async function voidExpense(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const cur = await getExpense(client, ctx, id);
  if (String(cur.status) === 'VOID') throw badRequest('Expense is already void');
  if (!reason) throw badRequest('A void reason is required');
  if (cur.glPosted === true && cur.glJournalId != null) {
    await finance.voidJournal(client, ctx, Number(cur.glJournalId), reason);
    await client.query(
      `UPDATE financial_postings SET status = 'REVERSED' WHERE ref_type = 'EXPENSE' AND ref_id = $1 AND journal_id = $2`,
      [id, Number(cur.glJournalId)]
    );
  }
  await client.query(
    `UPDATE expense_transactions
        SET status = 'VOID', accounting_status = CASE WHEN gl_posted THEN 'REVERSED' ELSE accounting_status END,
            voided_by = $1, voided_at = now(), void_reason = $2, updated_by = $1
      WHERE id = $3`,
    [ctx.userId ?? null, reason, id]
  );
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, comment)
     VALUES ($1,$2,'ops.expenses',$3,$4,'VOID',$5,$6)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.expNo), ctx.userId ?? null, reason]
  );
  await logAudit(client, ctx, { action: 'void', resource: 'expenses', recordId: id, recordCode: String(cur.expNo), newValues: { status: 'VOID', reason } });
  await emitEvent(client, ctx, { eventType: 'expense.voided', entityType: 'ops.expenses', entityId: id, entityCode: String(cur.expNo), payload: { reason } });
  return getExpense(client, ctx, id);
}

const EXPENSE_SELECT = `
  SELECT et.*, d.code AS department_code, d.name AS department_name,
         cc.code AS cost_centre_code, cc.name AS cost_centre_name,
         c.code AS category_code, c.name AS category_name, c.account_id AS category_account_id,
         pm.code AS payment_method_code, pm.name AS payment_method_name, pm.method_type AS payment_method_type,
         p.code AS project_code, p.name AS project_name,
         su.code AS supplier_code, su.name AS supplier_name,
         e.employee_no, e.first_name, e.last_name,
         b.budget_no,
         r.req_no,
         (u.first_name || ' ' || u.last_name) AS created_by_name
  FROM expense_transactions et
  LEFT JOIN departments d ON d.id = et.department_id
  LEFT JOIN cost_centres cc ON cc.id = et.cost_centre_id
  LEFT JOIN expense_categories c ON c.id = et.category_id
  LEFT JOIN payment_methods pm ON pm.id = et.payment_method_id
  LEFT JOIN projects p ON p.id = et.project_id
  LEFT JOIN suppliers su ON su.id = et.supplier_id
  LEFT JOIN employees e ON e.id = et.employee_id
  LEFT JOIN budgets b ON b.id = et.budget_id
  LEFT JOIN requisitions r ON r.id = et.requisition_id
  LEFT JOIN users u ON u.id = et.created_by
`;

export async function getExpense(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(`${EXPENSE_SELECT} WHERE et.id = $1 AND et.tenant_id = $2 AND et.company_id = $3`, [
    id, ctx.tenantId, companyId(ctx),
  ]);
  if (!res.rows.length) throw notFound('Expense not found');
  const header = toCamelRow(res.rows[0]);
  const lines = await client.query(
    `SELECT * FROM expense_lines WHERE expense_transaction_id = $1 ORDER BY line_no`,
    [id]
  );
  const receipts = await client.query(
    `SELECT id, file_name, mime_type, file_url, content_hash, supplier, invoice_no, receipt_date,
            tax_amount, total, currency, ocr_data, verified, is_primary, created_by, created_at
     FROM expense_receipts WHERE ref_type = 'EXPENSE' AND ref_id = $1 ORDER BY is_primary DESC, id DESC`,
    [id]
  );
  const actions = await client.query(
    `SELECT aa.*, u.first_name || ' ' || u.last_name AS actor_name
     FROM approval_actions aa LEFT JOIN users u ON u.id = aa.actor_user_id
     WHERE aa.entity_type = 'ops.expenses' AND aa.entity_id = $1 ORDER BY aa.id`,
    [id]
  );
  const dup = header.duplicateOfId != null ? await getExpense(client, ctx, Number(header.duplicateOfId)) : null;
  return {
    ...header,
    lines: toCamelRows(lines.rows),
    receipts: toCamelRows(receipts.rows),
    timeline: toCamelRows(actions.rows),
    duplicateOf: dup ? { id: dup.id, expNo: dup.expNo, amount: dup.amount, status: dup.status } : null,
  };
}

export async function listExpenses(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const page = Math.max(1, num0(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, num0(q.pageSize) || 30));
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['et.tenant_id = $1', 'et.company_id = $2'];
  if (s(q.status)) { params.push(s(q.status)); where.push(`et.status = $${params.length}`); }
  if (s(q.paymentStatus)) { params.push(s(q.paymentStatus)); where.push(`et.payment_status = $${params.length}`); }
  if (n(q.departmentId) != null) { params.push(n(q.departmentId)); where.push(`et.department_id = $${params.length}`); }
  if (n(q.costCentreId) != null) { params.push(n(q.costCentreId)); where.push(`et.cost_centre_id = $${params.length}`); }
  if (n(q.categoryId) != null) { params.push(n(q.categoryId)); where.push(`et.category_id = $${params.length}`); }
  if (n(q.projectId) != null) { params.push(n(q.projectId)); where.push(`et.project_id = $${params.length}`); }
  if (n(q.supplierId) != null) { params.push(n(q.supplierId)); where.push(`et.supplier_id = $${params.length}`); }
  if (n(q.employeeId) != null) { params.push(n(q.employeeId)); where.push(`et.employee_id = $${params.length}`); }
  if (s(q.from)) { params.push(s(q.from)); where.push(`et.exp_date >= $${params.length}`); }
  if (s(q.to)) { params.push(s(q.to)); where.push(`et.exp_date <= $${params.length}`); }
  if (s(q.q)) {
    params.push(`%${s(q.q)}%`);
    where.push(`(et.exp_no ILIKE $${params.length} OR et.description ILIKE $${params.length} OR et.payee ILIKE $${params.length} OR et.reference ILIKE $${params.length})`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await client.query(
    `${EXPENSE_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY et.exp_date DESC, et.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const cnt = await client.query(
    `SELECT count(*)::int AS total FROM expense_transactions et WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(rows.rows), total: cnt.rows[0].total, page, pageSize };
}

export async function expenseBoard(client: pg.PoolClient, ctx: Ctx) {
  const [pending, drafts, unreceipted, overdue, today] = await Promise.all([
    client.query(
      `SELECT et.id, et.exp_no, et.exp_date, et.description, et.amount, et.status, et.payment_status, et.risk_level,
              d.name AS department_name, c.name AS category_name, (u.first_name || ' ' || u.last_name) AS requester
       FROM expense_transactions et
       LEFT JOIN departments d ON d.id = et.department_id
       LEFT JOIN expense_categories c ON c.id = et.category_id
       LEFT JOIN users u ON u.id = et.created_by
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.status IN ('SUBMITTED','APPROVED')
       ORDER BY et.exp_date, et.id LIMIT 50`,
      [ctx.tenantId, companyId(ctx)]
    ),
    client.query(
      `SELECT et.id, et.exp_no, et.exp_date, et.description, et.amount, et.risk_level,
              d.name AS department_name, c.name AS category_name
       FROM expense_transactions et
       LEFT JOIN departments d ON d.id = et.department_id
       LEFT JOIN expense_categories c ON c.id = et.category_id
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.status = 'DRAFT'
       ORDER BY et.id DESC LIMIT 30`,
      [ctx.tenantId, companyId(ctx)]
    ),
    client.query(
      `SELECT et.id, et.exp_no, et.description, et.amount, d.name AS department_name
       FROM expense_transactions et
       LEFT JOIN departments d ON d.id = et.department_id
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.status NOT IN ('VOID','REJECTED')
         AND NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.ref_type = 'EXPENSE' AND er.ref_id = et.id)
       ORDER BY et.exp_date DESC LIMIT 30`,
      [ctx.tenantId, companyId(ctx)]
    ),
    client.query(
      `SELECT et.id, et.exp_no, et.description, et.amount, et.risk_level, et.created_at
       FROM expense_transactions et
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.status IN ('SUBMITTED','APPROVED')
         AND et.exp_date < CURRENT_DATE
       ORDER BY et.exp_date LIMIT 30`,
      [ctx.tenantId, companyId(ctx)]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date = CURRENT_DATE AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, companyId(ctx)]
    ),
  ]);
  return {
    pendingApproval: toCamelRows(pending.rows),
    drafts: toCamelRows(drafts.rows),
    missingReceipts: toCamelRows(unreceipted.rows),
    overdueApproval: toCamelRows(overdue.rows),
    today: toCamelRow(today.rows[0] ?? {}),
  };
}

export async function expenseSummary(client: pg.PoolClient, ctx: Ctx) {
  const byStatus = await client.query(
    `SELECT status, payment_status, count(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total
     FROM expense_transactions
     WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','REJECTED')
     GROUP BY status, payment_status ORDER BY status`,
    [ctx.tenantId, companyId(ctx)]
  );
  const byCategory = await client.query(
    `SELECT c.id, c.code, c.name, COALESCE(SUM(et.amount),0)::numeric AS total, count(*)::int AS count
     FROM expense_categories c
     LEFT JOIN expense_transactions et ON et.category_id = c.id
       AND et.tenant_id = $1 AND et.company_id = $2 AND et.status NOT IN ('VOID','REJECTED')
     WHERE c.company_id = $2 AND c.tenant_id = $1
     GROUP BY c.id ORDER BY total DESC LIMIT 20`,
    [ctx.tenantId, companyId(ctx)]
  );
  const risk = await client.query(
    `SELECT risk_level, count(*)::int AS count FROM expense_transactions
     WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','REJECTED')
     GROUP BY risk_level ORDER BY risk_level`,
    [ctx.tenantId, companyId(ctx)]
  );
  return {
    byStatus: toCamelRows(byStatus.rows),
    byCategory: toCamelRows(byCategory.rows),
    riskProfile: toCamelRows(risk.rows),
  };
}

// ---- Receipts / digital evidence ----

export async function listReceipts(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['tenant_id = $1', 'company_id = $2'];
  if (s(q.refType)) { params.push(s(q.refType)); where.push(`ref_type = $${params.length}`); }
  if (n(q.refId) != null) { params.push(n(q.refId)); where.push(`ref_id = $${params.length}`); }
  if (s(q.q)) {
    params.push(`%${s(q.q)}%`);
    where.push(`(file_name ILIKE $${params.length} OR supplier ILIKE $${params.length} OR invoice_no ILIKE $${params.length})`);
  }
  params.push(50, 0);
  const rows = await client.query(
    `SELECT id, ref_type, ref_id, file_name, mime_type, file_url, content_hash, supplier, invoice_no,
            receipt_date, tax_amount, total, currency, ocr_data, verified, is_primary, created_by, created_at
     FROM expense_receipts WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return toCamelRows(rows.rows);
}

export async function uploadReceipt(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const refType = String(b.refType ?? '').toUpperCase();
  const refId = n(b.refId);
  if (!['EXPENSE', 'CLAIM', 'REQUISITION', 'REPLENISHMENT', 'SUPPLIER_INVOICE', 'PAYMENT'].includes(refType)) {
    throw badRequest('Invalid receipt refType');
  }
  if (refId == null) throw badRequest('refId is required');
  const file = b.file as { originalname?: string; mimetype?: string; size?: number; buffer?: Buffer } | undefined;
  const storageKey = s(b.storageKey);
  if (!file?.buffer && !storageKey) throw badRequest('Provide a file upload or an existing storageKey');
  const { createHash } = await import('node:crypto');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { config } = await import('../config.js');
  let checksum = '';
  let fileName = 'receipt';
  let mime = 'application/octet-stream';
  let fileSize = 0;
  if (file?.buffer) {
    fileName = String(file.originalname ?? 'receipt').replace(/[^A-Za-z0-9._-]+/g, '_');
    mime = String(file.mimetype ?? 'application/octet-stream');
    fileSize = Number(file.size) || file.buffer.length;
    checksum = createHash('sha256').update(file.buffer).digest('hex');
  }
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const resolvedKey = storageKey ?? `receipts/${ctx.companyId}/${refType.toLowerCase()}-${refId}/${Date.now()}-${safeName}`;
  if (file?.buffer) {
    mkdirSync(path.join(config.storageRoot, path.dirname(resolvedKey)), { recursive: true });
    writeFileSync(path.join(config.storageRoot, resolvedKey), file.buffer);
  }
  const dup = await duplicateScan(client, ctx, { contentHash: checksum || undefined });
  const ins = await client.query(
    `INSERT INTO expense_receipts
       (company_id, tenant_id, ref_type, ref_id, document_id, file_name, mime_type, file_url,
        content_hash, supplier, invoice_no, receipt_date, tax_amount, total, currency, ocr_data,
        verified, is_primary, created_by)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,false,$16,$17)
     RETURNING id`,
    [companyId(ctx), ctx.tenantId, refType, refId, fileName, mime, resolvedKey, checksum || null,
     s(b.supplier), s(b.invoiceNo), s(b.receiptDate), n(b.taxAmount) != null ? round2(num0(b.taxAmount)) : null,
     n(b.total) != null ? round2(num0(b.total)) : null, s(b.currency) ?? 'UGX',
     JSON.stringify(b.ocrData ?? {}), b.isPrimary === true || b.isPrimary === 'true', ctx.userId ?? null]
  );
  const receiptId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'upload_receipt', resource: 'expenses.receipts', recordId: receiptId, recordCode: fileName, newValues: { refType, refId, checksum } });
  const row = await client.query(`SELECT * FROM expense_receipts WHERE id = $1`, [receiptId]);
  return { ...toCamelRow(row.rows[0]), possibleDuplicate: dup.possibleDuplicate, duplicateMatches: dup.hashMatches };
}

export async function verifyReceipt(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const row = await client.query(`SELECT * FROM expense_receipts WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [
    id, ctx.tenantId, companyId(ctx),
  ]);
  if (!row.rows.length) throw notFound('Receipt not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [camel, col] of Object.entries({ supplier: 'supplier', invoiceNo: 'invoice_no', receiptDate: 'receipt_date', taxAmount: 'tax_amount', total: 'total', currency: 'currency' })) {
    if (camel in b) {
      params.push(camel === 'receiptDate' ? isoDate(b[camel]) : camel === 'taxAmount' || camel === 'total' ? round2(num0(b[camel])) : s(b[camel]));
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (b.ocrData) { params.push(JSON.stringify(b.ocrData)); sets.push(`ocr_data = $${params.length}`); }
  if (b.verified === true || b.verified === 'true') {
    params.push(ctx.userId ?? null);
    sets.push(`verified = true, verified_by = $${params.length}, verified_at = now()`);
  }
  if (sets.length === 0) return toCamelRow(row.rows[0]);
  params.push(id);
  await client.query(`UPDATE expense_receipts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  await logAudit(client, ctx, { action: 'verify_receipt', resource: 'expenses.receipts', recordId: id, recordCode: String(row.rows[0].file_name), newValues: { verified: true } });
  const updated = await client.query(`SELECT * FROM expense_receipts WHERE id = $1`, [id]);
  return toCamelRow(updated.rows[0]);
}

// ---- Petty cash ----

export async function pettyCashDesk(client: pg.PoolClient, ctx: Ctx) {
  const funds = await client.query(
    `SELECT f.*, u.first_name || ' ' || u.last_name AS custodian_name,
            (SELECT COALESCE(SUM(pct.amount),0)::numeric FROM petty_cash_transactions pct
              WHERE pct.fund_id = f.id AND pct.tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')) AS cash_in,
            (SELECT COALESCE(SUM(pct.amount),0)::numeric FROM petty_cash_transactions pct
              WHERE pct.fund_id = f.id AND pct.tx_type = 'EXPENSE') AS cash_out
     FROM petty_cash_funds f
     LEFT JOIN users u ON u.id = f.custodian_user_id
     WHERE f.company_id = $1 AND f.tenant_id = $2
     ORDER BY f.name`,
    [companyId(ctx), ctx.tenantId]
  );
  const replenishments = await client.query(
    `SELECT pr.*, f.name AS fund_name, f.code AS fund_code, (u.first_name || ' ' || u.last_name) AS requested_by_name
     FROM petty_cash_replenishments pr
     JOIN petty_cash_funds f ON f.id = pr.fund_id
     LEFT JOIN users u ON u.id = pr.requested_by
     WHERE pr.company_id = $1 AND pr.tenant_id = $2
     ORDER BY pr.id DESC LIMIT 20`,
    [companyId(ctx), ctx.tenantId]
  );
  const openBalance = await client.query(
    `SELECT COALESCE(SUM(opening_balance),0)::numeric AS opening,
            COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS received,
            COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_type = 'EXPENSE'),0)::numeric AS spent
     FROM petty_cash_funds WHERE company_id = $2 AND tenant_id = $1`,
    [ctx.tenantId, companyId(ctx)]
  );
  return {
    funds: toCamelRows(funds.rows).map((f: Record<string, unknown>) => ({
      ...f,
      cashIn: num0(f.cashIn), cashOut: num0(f.cashOut),
      closingBalance: round2(num0(f.openingBalance) + num0(f.cashIn) - num0(f.cashOut)),
    })),
    replenishments: toCamelRows(replenishments.rows),
    totals: toCamelRow(openBalance.rows[0] ?? {}),
  };
}

export async function getPettyCashFund(client: pg.PoolClient, ctx: Ctx, fundId: number) {
  const fund = await client.query(
    `SELECT f.*, u.first_name || ' ' || u.last_name AS custodian_name
     FROM petty_cash_funds f LEFT JOIN users u ON u.id = f.custodian_user_id
     WHERE f.id = $1 AND f.tenant_id = $2 AND f.company_id = $3`,
    [fundId, ctx.tenantId, companyId(ctx)]
  );
  if (!fund.rows.length) throw notFound('Petty cash fund not found');
  const txs = await client.query(
    `SELECT pct.*, et.exp_no, (u.first_name || ' ' || u.last_name) AS created_by_name
     FROM petty_cash_transactions pct
     LEFT JOIN expense_transactions et ON et.id = pct.expense_transaction_id
     LEFT JOIN users u ON u.id = pct.created_by
     WHERE pct.fund_id = $1 ORDER BY pct.tx_date DESC, pct.id DESC LIMIT 100`,
    [fundId]
  );
  const cashIn = num0(txs.rows.filter((t: any) => ['RECEIPT', 'TOP_UP', 'RETURN', 'REPLENISHMENT'].includes(String(t.tx_type))).reduce((a: number, t: any) => a + num0(t.amount), 0));
  const cashOut = num0(txs.rows.filter((t: any) => String(t.tx_type) === 'EXPENSE').reduce((a: number, t: any) => a + num0(t.amount), 0));
  return {
    ...toCamelRow(fund.rows[0]),
    transactions: toCamelRows(txs.rows),
    cashIn,
    cashOut,
    closingBalance: round2(num0(fund.rows[0].opening_balance) + cashIn - cashOut),
  };
}

export async function recordPettyCashTransaction(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const fundId = n(b.fundId);
  if (fundId == null) throw badRequest('fundId is required');
  const txType = String(b.txType ?? '').toUpperCase();
  if (!['RECEIPT', 'EXPENSE', 'TOP_UP', 'RETURN', 'ADJUSTMENT', 'REPLENISHMENT'].includes(txType)) {
    throw badRequest('Invalid petty cash transaction type');
  }
  const amount = round2(num0(b.amount));
  if (amount <= 0) throw badRequest('Amount must be greater than zero');
  const fund = await client.query(`SELECT * FROM petty_cash_funds WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`, [
    fundId, ctx.tenantId, companyId(ctx),
  ]);
  if (!fund.rows.length) throw notFound('Petty cash fund not found');
  const cashIn = txType === 'EXPENSE' ? 0 : amount;
  const cashOut = txType === 'EXPENSE' ? amount : 0;
  const lastBal = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN tx_type = 'EXPENSE' THEN -amount ELSE amount END),0)::numeric AS bal
     FROM petty_cash_transactions WHERE fund_id = $1`,
    [fundId]
  );
  const balanceAfter = round2(num0(fund.rows[0].opening_balance) + num0(lastBal.rows[0].bal) + cashIn - cashOut);
  const ins = await client.query(
    `INSERT INTO petty_cash_transactions
       (company_id, tenant_id, fund_id, tx_date, tx_type, amount, reference, description,
        expense_transaction_id, replenishment_id, created_by, balance_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [companyId(ctx), ctx.tenantId, fundId, isoDate(b.txDate), txType, amount, s(b.reference), s(b.description),
     n(b.expenseTransactionId), n(b.replenishmentId), ctx.userId ?? null, balanceAfter]
  );
  await logAudit(client, ctx, { action: txType.toLowerCase(), resource: 'expenses.petty_cash', recordId: Number(ins.rows[0].id), recordCode: String(b.reference ?? ''), newValues: { fundId, txType, amount, balanceAfter } });
  return { id: Number(ins.rows[0].id), balanceAfter, txType, amount };
}

export async function requestReplenishment(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const fundId = n(b.fundId);
  if (fundId == null) throw badRequest('fundId is required');
  const fund = await client.query(`SELECT * FROM petty_cash_funds WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [
    fundId, ctx.tenantId, companyId(ctx),
  ]);
  if (!fund.rows.length) throw notFound('Petty cash fund not found');
  const amount = round2(num0(b.amount) || num0(b.spent));
  if (amount <= 0) throw badRequest('Replenishment amount must be greater than zero');
  const repNo = await nextDoc(client, ctx, 'PCR');
  const ins = await client.query(
    `INSERT INTO petty_cash_replenishments
       (company_id, tenant_id, branch_id, rep_no, fund_id, rep_date, amount, reason, status, requested_by, payment_method_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10) RETURNING id`,
    [companyId(ctx), ctx.tenantId, ctx.branchId ?? null, repNo, fundId, isoDate(b.repDate), amount,
     s(b.reason) ?? `Petty cash replenishment for ${String(fund.rows[0].name)}`, ctx.userId ?? null, n(b.paymentMethodId)]
  );
  const repId = Number(ins.rows[0].id);
  await recordPettyCashTransaction(client, ctx, { fundId, txType: 'REPLENISHMENT', amount, reference: repNo, description: `Replenishment ${repNo}`, replenishmentId: repId });
  await logAudit(client, ctx, { action: 'create', resource: 'expenses.replenishments', recordId: repId, recordCode: repNo, newValues: { fundId, amount } });
  return getReplenishment(client, ctx, repId);
}

export async function getReplenishment(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT pr.*, f.code AS fund_code, f.name AS fund_name, f.float_amount,
            (u.first_name || ' ' || u.last_name) AS requested_by_name,
            (a.first_name || ' ' || a.last_name) AS approved_by_name
     FROM petty_cash_replenishments pr
     JOIN petty_cash_funds f ON f.id = pr.fund_id
     LEFT JOIN users u ON u.id = pr.requested_by
     LEFT JOIN users a ON a.id = pr.approved_by
     WHERE pr.id = $1 AND pr.tenant_id = $2 AND pr.company_id = $3`,
    [id, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Replenishment not found');
  return toCamelRow(res.rows[0]);
}

export async function submitReplenishment(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getReplenishment(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft replenishments can be submitted (current: ${cur.status})`);
  await client.query(`UPDATE petty_cash_replenishments SET status = 'SUBMITTED' WHERE id = $1`, [id]);
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.replenishments', entityId: id, entityCode: String(cur.repNo), amount: num0(cur.amount),
    companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.replenishments',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.repNo), ctx.userId ?? null, JSON.stringify({ amount: num0(cur.amount), instanceId })]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'expenses.replenishments', recordId: id, recordCode: String(cur.repNo), newValues: { status: 'SUBMITTED' } });
  return getReplenishment(client, ctx, id);
}

export async function payReplenishment(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const cur = await getReplenishment(client, ctx, id);
  if (cur.status !== 'APPROVED') throw badRequest(`Only approved replenishments can be paid (current: ${cur.status})`);
  await client.query(
    `UPDATE petty_cash_replenishments
        SET status = 'PAID', paid_by = $1, paid_at = now(), payment_method_id = COALESCE($2, payment_method_id)
      WHERE id = $3`,
    [ctx.userId ?? null, n(b.paymentMethodId), id]
  );
  await recordPettyCashTransaction(client, ctx, { fundId: Number(cur.fundId), txType: 'RECEIPT', amount: num0(cur.amount), reference: String(cur.repNo), description: `Replenishment cash received ${cur.repNo}`, replenishmentId: id });
  await logAudit(client, ctx, { action: 'pay', resource: 'expenses.replenishments', recordId: id, recordCode: String(cur.repNo), newValues: { status: 'PAID' } });
  return getReplenishment(client, ctx, id);
}

export async function reconcilePettyCash(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const fundId = n(b.fundId);
  if (fundId == null) throw badRequest('fundId is required');
  const counted = round2(num0(b.countedAmount));
  const fund = await getPettyCashFund(client, ctx, fundId);
  const expected = round2(num0(fund.closingBalance));
  const variance = round2(counted - expected);
  const status = Math.abs(variance) <= 0.005 ? 'MATCHED' : 'VARIANCE';
  const ins = await client.query(
    `INSERT INTO cash_reconciliations
       (company_id, tenant_id, ref_type, ref_id, fund_id, cash_date, expected_amount, counted_amount,
        variance, variance_explanation, reconciled_by, reconciled_at, status)
     VALUES ($1,$2,'PETTY_CASH',$3,$3,$4,$5,$6,$7,$8,$9,now(),$10) RETURNING id`,
    [companyId(ctx), ctx.tenantId, fundId, isoDate(b.cashDate), expected, counted, variance,
     s(b.varianceExplanation) ?? null, ctx.userId ?? null, status]
  );
  if (status === 'VARIANCE' && !s(b.varianceExplanation)) {
    throw badRequest('A variance explanation is required when counted cash differs from the expected balance', { variance });
  }
  await logAudit(client, ctx, { action: 'reconcile', resource: 'expenses.petty_cash', recordId: Number(ins.rows[0].id), recordCode: `PC-${fundId}`, newValues: { expected, counted, variance, status } });
  return { id: Number(ins.rows[0].id), fundId, expected, counted, variance, status };
}

// ---- Employee expense claims ----

export async function createClaim(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const amount = round2(num0(b.amount));
  if (amount <= 0) throw badRequest('Claim amount must be greater than zero');
  const claimNo = await nextDoc(client, ctx, 'CLM');
  const ins = await client.query(
    `INSERT INTO employee_expense_claims
       (company_id, tenant_id, branch_id, claim_no, employee_id, created_by, trip, description, expense_date,
        amount, status, payment_method_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11) RETURNING id`,
    [companyId(ctx), ctx.tenantId, ctx.branchId ?? null, claimNo, n(b.employeeId), ctx.userId ?? null,
     s(b.trip), s(b.description), isoDate(b.expenseDate), amount, n(b.paymentMethodId)]
  );
  const claimId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'expenses.claims', recordId: claimId, recordCode: claimNo, newValues: { amount } });
  return getClaim(client, ctx, claimId);
}

export async function getClaim(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT cl.*, e.employee_no, e.first_name, e.last_name,
            (u.first_name || ' ' || u.last_name) AS created_by_name,
            pm.name AS payment_method_name
     FROM employee_expense_claims cl
     LEFT JOIN employees e ON e.id = cl.employee_id
     LEFT JOIN users u ON u.id = cl.created_by
     LEFT JOIN payment_methods pm ON pm.id = cl.payment_method_id
     WHERE cl.id = $1 AND cl.tenant_id = $2 AND cl.company_id = $3`,
    [id, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Claim not found');
  const receipts = await client.query(
    `SELECT id, file_name, mime_type, file_url, content_hash, supplier, invoice_no, receipt_date, tax_amount, total, currency, ocr_data, verified, is_primary
     FROM expense_receipts WHERE ref_type = 'CLAIM' AND ref_id = $1 ORDER BY id DESC`,
    [id]
  );
  return { ...toCamelRow(res.rows[0]), receipts: toCamelRows(receipts.rows) };
}

export async function listClaims(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['cl.tenant_id = $1', 'cl.company_id = $2'];
  if (s(q.status)) { params.push(s(q.status)); where.push(`cl.status = $${params.length}`); }
  if (n(q.employeeId) != null) { params.push(n(q.employeeId)); where.push(`cl.employee_id = $${params.length}`); }
  params.push(50, 0);
  const rows = await client.query(
    `SELECT cl.*, e.employee_no, e.first_name, e.last_name, (u.first_name || ' ' || u.last_name) AS created_by_name
     FROM employee_expense_claims cl
     LEFT JOIN employees e ON e.id = cl.employee_id
     LEFT JOIN users u ON u.id = cl.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY cl.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return toCamelRows(rows.rows);
}

export async function submitClaim(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getClaim(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft claims can be submitted (current: ${cur.status})`);
  await client.query(`UPDATE employee_expense_claims SET status = 'SUBMITTED' WHERE id = $1`, [id]);
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.claims', entityId: id, entityCode: String(cur.claimNo), amount: num0(cur.amount),
    companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.claims',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.claimNo), ctx.userId ?? null, JSON.stringify({ amount: num0(cur.amount), instanceId })]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'expenses.claims', recordId: id, recordCode: String(cur.claimNo), newValues: { status: 'SUBMITTED' } });
  return getClaim(client, ctx, id);
}

export async function reimburseClaim(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const cur = await getClaim(client, ctx, id);
  if (cur.status !== 'APPROVED') throw badRequest(`Only approved claims can be reimbursed (current: ${cur.status})`);
  await client.query(
    `UPDATE employee_expense_claims
        SET status = 'REIMBURSED', reimbursed_by = $1, reimbursed_at = now(), payment_method_id = COALESCE($2, payment_method_id)
      WHERE id = $3`,
    [ctx.userId ?? null, n(b.paymentMethodId), id]
  );
  const journalId = await finance.postJournalLines(client, ctx, {
    entryDate: new Date().toISOString().slice(0, 10),
    journalType: 'EXPENSE',
    description: `Employee claim reimbursement ${cur.claimNo}`,
    lines: [
      { account_id: await finance.getAccountId(client, ctx, '6100'), debit: num0(cur.amount), credit: 0, description: `Claim ${cur.claimNo}` },
      { account_id: await finance.getAccountId(client, ctx, '1200'), debit: 0, credit: num0(cur.amount), description: `Reimbursement ${cur.claimNo}` },
    ],
    refType: 'claim', refId: id, refCode: String(cur.claimNo),
  });
  await client.query(
    `UPDATE employee_expense_claims SET gl_posted = true, gl_journal_id = $1 WHERE id = $2`,
    [journalId, id]
  );
  await client.query(
    `INSERT INTO financial_postings (company_id, tenant_id, ref_type, ref_id, ref_code, journal_id, posting_type, amount, posted_by)
     VALUES ($1,$2,'CLAIM',$3,$4,$5,'REIMBURSEMENT',$6,$7)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.claimNo), journalId, num0(cur.amount), ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'reimburse', resource: 'expenses.claims', recordId: id, recordCode: String(cur.claimNo), newValues: { status: 'REIMBURSED', journalId } });
  return getClaim(client, ctx, id);
}

// ---- Daily cash close ----

const DCC_SELECT = `
  SELECT dc.*, br.name AS branch_name,
         (u.first_name || ' ' || u.last_name) AS submitted_by_name,
         (a.first_name || ' ' || a.last_name) AS approved_by_name
  FROM daily_cash_closings dc
  LEFT JOIN branches br ON br.id = dc.branch_id
  LEFT JOIN users u ON u.id = dc.submitted_by
  LEFT JOIN users a ON a.id = dc.approved_by
`;

export async function getDailyClose(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `${DCC_SELECT} WHERE dc.id = $1 AND dc.tenant_id = $2 AND dc.company_id = $3`,
    [id, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Daily close not found');
  const recs = await client.query(
    `SELECT id, ref_type, ref_id, fund_id, cash_date, expected_amount, counted_amount, variance,
            variance_explanation, reconciled_by, reconciled_at, status
     FROM cash_reconciliations WHERE ref_type = 'DAILY_CLOSE' AND ref_id = $1 ORDER BY id`,
    [id]
  );
  return { ...toCamelRow(res.rows[0]), reconciliations: toCamelRows(recs.rows) };
}

/** Aggregates for a business date: spend, receipt coverage, petty cash flows and the existing close (if any). */
export async function dailyCloseStatus(client: pg.PoolClient, ctx: Ctx, date?: string) {
  const closeDate = date ? isoDate(date) : new Date().toISOString().slice(0, 10);
  const [expenses, byStatus, unreceipted, cash, receipted, existing] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date = $3 AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, companyId(ctx), closeDate]
    ),
    client.query(
      `SELECT status, COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date = $3 AND status NOT IN ('VOID','REJECTED')
       GROUP BY status ORDER BY status`,
      [ctx.tenantId, companyId(ctx), closeDate]
    ),
    client.query(
      `SELECT count(*)::int AS count, COALESCE(SUM(et.amount),0)::numeric AS total
       FROM expense_transactions et
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.exp_date = $3 AND et.status NOT IN ('VOID','REJECTED')
         AND NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.ref_type = 'EXPENSE' AND er.ref_id = et.id)`,
      [ctx.tenantId, companyId(ctx), closeDate]
    ),
    client.query(
      `SELECT
         COALESCE((SELECT SUM(opening_balance) FROM petty_cash_funds WHERE company_id = $1 AND tenant_id = $2),0)::numeric AS opening,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date = $3 AND tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS received,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date = $3 AND tx_type = 'EXPENSE'),0)::numeric AS spent`,
      [ctx.tenantId, companyId(ctx), closeDate]
    ),
    client.query(
      `SELECT count(*)::int AS count FROM expense_receipts
       WHERE tenant_id = $1 AND company_id = $2 AND ref_type = 'EXPENSE'
         AND ref_id IN (SELECT id FROM expense_transactions WHERE exp_date = $3)`,
      [ctx.tenantId, companyId(ctx), closeDate]
    ),
    client.query(`${DCC_SELECT} WHERE dc.tenant_id = $1 AND dc.company_id = $2 AND dc.close_date = $3`, [
      ctx.tenantId, companyId(ctx), closeDate,
    ]),
  ]);
  const total = num0(expenses.rows[0].total);
  return {
    closeDate,
    totalExpenditure: total,
    expensesCount: Number(expenses.rows[0].count),
    byStatus: toCamelRows(byStatus.rows),
    unreceipted: toCamelRow(unreceipted.rows[0] ?? {}),
    receiptsCount: Number(receipted.rows[0].count),
    pettyCash: toCamelRow(cash.rows[0] ?? {}),
    existingClose: existing.rows.length ? toCamelRow(existing.rows[0]) : null,
    closed: existing.rows.length > 0 && ['SUBMITTED', 'APPROVED'].includes(String(existing.rows[0].status)),
  };
}

export async function createDailyClose(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const closeDate = isoDate(b.closeDate ?? new Date().toISOString().slice(0, 10));
  const company = companyId(ctx);
  const existing = await client.query(
    `SELECT id FROM daily_cash_closings WHERE company_id = $1 AND tenant_id = $2 AND close_date = $3`,
    [company, ctx.tenantId, closeDate]
  );
  if (existing.rows.length) throw badRequest('A daily close already exists for this date');
  const cash = await client.query(
    `SELECT
       COALESCE((SELECT SUM(opening_balance) FROM petty_cash_funds WHERE company_id = $1 AND tenant_id = $2),0)::numeric AS opening,
       COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date = $3 AND tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS received,
       COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date = $3 AND tx_type = 'EXPENSE'),0)::numeric AS spent`,
    [company, ctx.tenantId, closeDate]
  );
  const opening = round2(num0(cash.rows[0].opening));
  const received = round2(num0(cash.rows[0].received));
  const spent = round2(num0(cash.rows[0].spent));
  const transfers = round2(num0(b.cashTransfers));
  const expected = round2(opening + received - spent + transfers);
  const physical = b.physicalCash != null ? round2(num0(b.physicalCash)) : expected;
  const variance = round2(physical - expected);
  if (Math.abs(variance) > 0.005 && !s(b.varianceExplanation)) {
    throw badRequest('A variance explanation is required when physical cash differs from the expected closing balance', { variance });
  }
  const closeNo = await nextDoc(client, ctx, 'CLS');
  const ins = await client.query(
    `INSERT INTO daily_cash_closings
       (company_id, tenant_id, branch_id, close_no, close_date, opening_cash, cash_received, cash_spent,
        cash_transfers, expected_closing, physical_cash, variance, variance_explanation, review_notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'DRAFT') RETURNING id`,
    [company, ctx.tenantId, ctx.branchId ?? null, closeNo, closeDate, opening, received, spent, transfers,
     expected, physical, variance, s(b.varianceExplanation), JSON.stringify(b.reviewNotes ?? {})]
  );
  const closeId = Number(ins.rows[0].id);
  await client.query(
    `INSERT INTO cash_reconciliations
       (company_id, tenant_id, ref_type, ref_id, cash_date, expected_amount, counted_amount, variance,
        variance_explanation, reconciled_by, reconciled_at, status)
     VALUES ($1,$2,'DAILY_CLOSE',$3,$4,$5,$6,$7,$8,$9,now(),$10)`,
    [company, ctx.tenantId, closeId, closeDate, expected, physical, variance,
     s(b.varianceExplanation), ctx.userId ?? null, Math.abs(variance) <= 0.005 ? 'MATCHED' : 'VARIANCE']
  );
  await logAudit(client, ctx, { action: 'create', resource: 'expenses.daily_close', recordId: closeId, recordCode: closeNo, newValues: { closeDate, expected, physical, variance } });
  return getDailyClose(client, ctx, closeId);
}

export async function submitDailyClose(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getDailyClose(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft daily closes can be submitted (current: ${cur.status})`);
  await client.query(
    `UPDATE daily_cash_closings SET status = 'SUBMITTED', submitted_by = $1, submitted_at = now() WHERE id = $2`,
    [ctx.userId ?? null, id]
  );
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.daily_closings', entityId: id, entityCode: String(cur.closeNo),
    amount: Math.abs(num0(cur.variance)), companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.daily_closings',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.closeNo), ctx.userId ?? null,
     JSON.stringify({ closeDate: String(cur.closeDate), variance: num0(cur.variance), instanceId })]
  );
  await notifyRole(client, ctx, ['finance_manager'], {
    type: 'ops.daily_close', title: `Daily close ${cur.closeNo} awaiting approval`,
    body: `Daily close for ${String(cur.closeDate)} (variance ${num0(cur.variance).toLocaleString()}) is pending finance approval.`,
    link: '/spend/expenses', entityType: 'ops.daily_closings', entityId: id, severity: 'INFO', actionRequired: true,
  });
  await logAudit(client, ctx, { action: 'submit', resource: 'expenses.daily_close', recordId: id, recordCode: String(cur.closeNo), newValues: { status: 'SUBMITTED', instanceId } });
  return getDailyClose(client, ctx, id);
}

export async function listDailyClosings(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['dc.tenant_id = $1', 'dc.company_id = $2'];
  if (s(q.status)) { params.push(s(q.status)); where.push(`dc.status = $${params.length}`); }
  if (s(q.from)) { params.push(s(q.from)); where.push(`dc.close_date >= $${params.length}`); }
  if (s(q.to)) { params.push(s(q.to)); where.push(`dc.close_date <= $${params.length}`); }
  params.push(50, 0);
  const rows = await client.query(
    `${DCC_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY dc.close_date DESC, dc.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return toCamelRows(rows.rows);
}

// ---- Command centre / dashboards ----

export async function expenditureDashboard(client: pg.PoolClient, ctx: Ctx) {
  const company = companyId(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [todayRow, mtdRow, deptRows, pmtRows, pending, unreceipted, budgetRow] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date = $3 AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, company, today]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= $3 AND exp_date <= $4 AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, company, monthStart, today]
    ),
    client.query(
      `SELECT d.id, d.code, d.name, COALESCE(SUM(et.amount),0)::numeric AS total, count(*)::int AS count
       FROM departments d
       LEFT JOIN expense_transactions et ON et.department_id = d.id
         AND et.tenant_id = $1 AND et.company_id = $2 AND et.exp_date >= $3 AND et.exp_date <= $4
         AND et.status NOT IN ('VOID','REJECTED')
       WHERE d.company_id = $2 AND d.tenant_id = $1 AND d.status = 'ACTIVE'
       GROUP BY d.id ORDER BY total DESC LIMIT 12`,
      [ctx.tenantId, company, monthStart, today]
    ),
    client.query(
      `SELECT pm.method_type, COALESCE(SUM(et.amount),0)::numeric AS total
       FROM payment_methods pm
       LEFT JOIN expense_transactions et ON et.payment_method_id = pm.id
         AND et.tenant_id = $1 AND et.company_id = $2 AND et.exp_date >= $3 AND et.exp_date <= $4
         AND et.status NOT IN ('VOID','REJECTED')
       WHERE pm.company_id = $2 AND pm.tenant_id = $1
       GROUP BY pm.method_type ORDER BY total DESC`,
      [ctx.tenantId, company, monthStart, today]
    ),
    client.query(
      `SELECT count(*)::int AS count FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND status = 'SUBMITTED'`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT count(*)::int AS count FROM expense_transactions et
       WHERE et.tenant_id = $1 AND et.company_id = $2 AND et.status NOT IN ('VOID','REJECTED')
         AND NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.ref_type = 'EXPENSE' AND er.ref_id = et.id)`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT COALESCE(SUM(bl.amount),0)::numeric AS approved
       FROM budgets b JOIN budget_lines bl ON bl.budget_id = b.id
       WHERE b.company_id = $1 AND b.tenant_id = $2 AND b.status IN ('APPROVED','ACTIVE')
         AND b.period_start <= $3 AND b.period_end >= $3`,
      [company, ctx.tenantId, today]
    ),
  ]);
  const todayTotal = num0(todayRow.rows[0].total);
  const mtdTotal = num0(mtdRow.rows[0].total);
  const budget = num0(budgetRow.rows[0].approved);
  const departments = toCamelRows(deptRows.rows).map((d: Record<string, unknown>) => ({
    ...d, total: num0(d.total), pct: mtdTotal > 0 ? round2((num0(d.total) / mtdTotal) * 100) : 0,
  }));
  // Over-budget alert: compare month spend against the budget position of each expense account.
  const accountRows = await client.query(
    `SELECT DISTINCT account_id FROM expense_transactions
     WHERE tenant_id = $1 AND company_id = $2 AND account_id IS NOT NULL
       AND exp_date >= $3 AND exp_date <= $4 AND status NOT IN ('VOID','REJECTED')`,
    [ctx.tenantId, company, monthStart, today]
  );
  const overBudgetAccounts: Array<Record<string, unknown>> = [];
  for (const row of accountRows.rows) {
    try {
      const pos = await finance.budgetPosition(client, ctx, Number(row.account_id));
      if (pos.available < 0) overBudgetAccounts.push({ accountId: Number(row.account_id), available: pos.available });
    } catch { /* advisory only */ }
  }
  const cashBank = toCamelRows(pmtRows.rows);
  return {
    today: { total: todayTotal, count: Number(todayRow.rows[0].count) },
    mtd: { total: mtdTotal, count: Number(mtdRow.rows[0].count) },
    budget: { approved: budget, consumed: mtdTotal, consumedPct: budget > 0 ? round2((mtdTotal / budget) * 100) : 0 },
    spendingByDepartment: departments,
    cashVsBank: cashBank,
    alerts: {
      pendingApprovals: Number(pending.rows[0].count),
      missingReceipts: Number(unreceipted.rows[0].count),
      overBudgetAccounts,
    },
  };
}

export async function cashPosition(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const company = companyId(ctx);
  const asOf = q.asOf ? isoDate(q.asOf) : new Date().toISOString().slice(0, 10);
  const [cash, funds, lastRec] = await Promise.all([
    client.query(
      `SELECT
         COALESCE((SELECT SUM(opening_balance) FROM petty_cash_funds WHERE company_id = $1 AND tenant_id = $2),0)::numeric AS opening,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date <= $3 AND tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS received,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_date <= $3 AND tx_type = 'EXPENSE'),0)::numeric AS spent`,
      [company, ctx.tenantId, asOf]
    ),
    client.query(
      `SELECT f.id, f.code, f.name, f.opening_balance, f.float_amount,
              COALESCE((SELECT SUM(pct.amount) FROM petty_cash_transactions pct WHERE pct.fund_id = f.id AND pct.tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS cash_in,
              COALESCE((SELECT SUM(pct.amount) FROM petty_cash_transactions pct WHERE pct.fund_id = f.id AND pct.tx_type = 'EXPENSE'),0)::numeric AS cash_out
       FROM petty_cash_funds f
       WHERE f.company_id = $1 AND f.tenant_id = $2 ORDER BY f.name`,
      [company, ctx.tenantId]
    ),
    client.query(
      `SELECT expected_amount, counted_amount, variance, variance_explanation, reconciled_by, reconciled_at, status
       FROM cash_reconciliations
       WHERE tenant_id = $1 AND company_id = $2 AND ref_type = 'PETTY_CASH'
       ORDER BY cash_date DESC, id DESC LIMIT 1`,
      [ctx.tenantId, company]
    ),
  ]);
  const opening = round2(num0(cash.rows[0].opening));
  const received = round2(num0(cash.rows[0].received));
  const spent = round2(num0(cash.rows[0].spent));
  const transfers = round2(num0(q.cashTransfers));
  const expected = round2(opening + received - spent + transfers);
  const physical = q.physicalCash != null ? round2(num0(q.physicalCash)) : lastRec.rows.length ? round2(num0(lastRec.rows[0].counted_amount)) : expected;
  const variance = round2(physical - expected);
  return {
    asOf,
    opening,
    cashReceived: received,
    cashSpent: spent,
    cashTransfers: transfers,
    expectedClosing: expected,
    physicalCash: physical,
    variance,
    funds: toCamelRows(funds.rows).map((f: Record<string, unknown>) => ({
      ...f,
      cashIn: num0(f.cashIn), cashOut: num0(f.cashOut),
      closingBalance: round2(num0(f.openingBalance) + num0(f.cashIn) - num0(f.cashOut)),
    })),
    lastReconciliation: lastRec.rows.length ? toCamelRow(lastRec.rows[0]) : null,
  };
}

export async function expenseReports(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const company = companyId(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const from = q.from ? isoDate(q.from) : `${today.slice(0, 8)}01`;
  const to = q.to ? isoDate(q.to) : today;
  const base = 'et.tenant_id = $1 AND et.company_id = $2 AND et.exp_date >= $3 AND et.exp_date <= $4 AND et.status NOT IN (\'VOID\',\'REJECTED\')';
  const groupBy = s(q.groupBy) ?? 'category';
  const groups: Record<string, string> = {
    department: 'd.name', category: 'c.name', supplier: 'su.name', employee: "(e.first_name || ' ' || e.last_name)",
    paymentMethod: 'pm.name', costCentre: 'cc.name', project: 'p.name',
  };
  const groupCol = groups[groupBy] ?? groups.category;
  const [daily, weekly, monthly, groupRows, trend, monthTrend, cashBank, planned, claims, pettyCash] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions WHERE tenant_id = $1 AND company_id = $2 AND exp_date = $3 AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, company, today]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= CURRENT_DATE - 6 AND exp_date <= CURRENT_DATE AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= $3 AND exp_date <= $4 AND status NOT IN ('VOID','REJECTED')`,
      [ctx.tenantId, company, `${today.slice(0, 8)}01`, today]
    ),
    client.query(
      `SELECT ${groupCol} AS label, COALESCE(SUM(et.amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions et
       LEFT JOIN departments d ON d.id = et.department_id
       LEFT JOIN expense_categories c ON c.id = et.category_id
       LEFT JOIN suppliers su ON su.id = et.supplier_id
       LEFT JOIN employees e ON e.id = et.employee_id
       LEFT JOIN payment_methods pm ON pm.id = et.payment_method_id
       LEFT JOIN cost_centres cc ON cc.id = et.cost_centre_id
       LEFT JOIN projects p ON p.id = et.project_id
       WHERE ${base}
       GROUP BY ${groupCol} ORDER BY total DESC LIMIT 30`,
      [ctx.tenantId, company, from, to]
    ),
    client.query(
      `SELECT exp_date AS day, COALESCE(SUM(amount),0)::numeric AS total
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= CURRENT_DATE - 13 AND exp_date <= CURRENT_DATE AND status NOT IN ('VOID','REJECTED')
       GROUP BY exp_date ORDER BY exp_date`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT to_char(date_trunc('month', exp_date), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months' AND status NOT IN ('VOID','REJECTED')
       GROUP BY 1 ORDER BY 1`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT pm.method_type, COALESCE(SUM(et.amount),0)::numeric AS total
       FROM payment_methods pm
       LEFT JOIN expense_transactions et ON et.payment_method_id = pm.id AND ${base}
       WHERE pm.company_id = $2 AND pm.tenant_id = $1
       GROUP BY pm.method_type ORDER BY total DESC`,
      [ctx.tenantId, company, from, to]
    ),
    client.query(
      `SELECT is_planned, COALESCE(SUM(amount),0)::numeric AS total, count(*)::int AS count
       FROM expense_transactions
       WHERE tenant_id = $1 AND company_id = $2 AND exp_date >= $3 AND exp_date <= $4 AND status NOT IN ('VOID','REJECTED')
       GROUP BY is_planned`,
      [ctx.tenantId, company, from, to]
    ),
    client.query(
      `SELECT status, count(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total
       FROM employee_expense_claims
       WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY status`,
      [ctx.tenantId, company]
    ),
    client.query(
      `SELECT
         COALESCE((SELECT SUM(opening_balance) FROM petty_cash_funds WHERE company_id = $1 AND tenant_id = $2),0)::numeric AS opening,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_type IN ('RECEIPT','TOP_UP','RETURN','REPLENISHMENT')),0)::numeric AS received,
         COALESCE((SELECT SUM(amount) FROM petty_cash_transactions WHERE tenant_id = $1 AND company_id = $2 AND tx_type = 'EXPENSE'),0)::numeric AS spent`,
      [company, ctx.tenantId]
    ),
  ]);
  const accountRows = await client.query(
    `SELECT DISTINCT account_id FROM expense_transactions
     WHERE tenant_id = $1 AND company_id = $2 AND account_id IS NOT NULL
       AND exp_date >= $3 AND exp_date <= $4 AND status NOT IN ('VOID','REJECTED')`,
    [ctx.tenantId, company, from, to]
  );
  const budgetVsActual: finance.BudgetPosition[] = [];
  for (const row of accountRows.rows) {
    try {
      const pos = await finance.budgetPosition(client, ctx, Number(row.account_id));
      if (pos.budgetId != null) budgetVsActual.push(pos);
    } catch { /* advisory only */ }
  }
  return {
    period: { from, to },
    daily: toCamelRow(daily.rows[0] ?? {}),
    weekly: toCamelRow(weekly.rows[0] ?? {}),
    monthly: toCamelRow(monthly.rows[0] ?? {}),
    grouped: toCamelRows(groupRows.rows),
    dailyTrend: toCamelRows(trend.rows),
    monthlyTrend: toCamelRows(monthTrend.rows),
    cashVsBank: toCamelRows(cashBank.rows),
    plannedVsUnplanned: toCamelRows(planned.rows),
    claims: toCamelRows(claims.rows),
    pettyCash: toCamelRow(pettyCash.rows[0] ?? {}),
    budgetVsActual,
  };
}
