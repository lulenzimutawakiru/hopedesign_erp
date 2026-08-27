import pg from 'pg';
import { createHash } from 'node:crypto';
import { Ctx } from '../db.js';
import {
  badRequest,
  notFound,
  parsePagination,
  toCamelRow,
  toCamelRows,
  toISODate,
} from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

async function loadPayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const res = await client.query(
    'SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE',
    [payrollId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payroll not found');
  return res.rows[0];
}

async function loadBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const res = await client.query(
    'SELECT * FROM payment_batches WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE',
    [batchId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payment batch not found');
  return res.rows[0];
}

/** Create a payment batch for an approved/released payroll run. */
export async function createPaymentBatch(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { payrollId: number; fileFormat?: string }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const payroll = await loadPayroll(client, ctx, input.payrollId);
  if (!['APPROVED', 'RELEASED'].includes(String(payroll.status))) {
    throw badRequest(`Payroll must be APPROVED or RELEASED before creating a payment batch (current: ${payroll.status})`);
  }
  const existing = await client.query(
    `SELECT batch_no, status FROM payment_batches
     WHERE payroll_id = $1 AND tenant_id = $2 AND status NOT IN ('CONFIRMED','RECONCILED')
     ORDER BY id DESC LIMIT 1`,
    [input.payrollId, ctx.tenantId]
  );
  if (existing.rows.length > 0) {
    throw badRequest(`Payment batch ${existing.rows[0].batch_no} already exists for this payroll (${existing.rows[0].status})`);
  }
  const items = await client.query(
    `SELECT i.*, e.employee_no, e.first_name, e.last_name, e.bank_name, e.bank_account_no, e.phone
     FROM payroll_items i
     JOIN employees e ON e.id = i.employee_id
     WHERE i.payroll_id = $1 ORDER BY e.last_name, e.first_name`,
    [input.payrollId]
  );
  if (items.rows.length === 0) throw badRequest('Payroll has no calculated employees to pay');

  const batchNo = await nextDoc(client, ctx, 'PB');
  const currency = String(payroll.currency ?? 'UGX');
  const totalAmount = round2(Number(payroll.net_total) || 0);
  const fileFormat = input.fileFormat ?? null;
  const batch = await client.query(
    `INSERT INTO payment_batches
       (company_id, tenant_id, branch_id, payroll_run_id, payroll_id, batch_no, batch_type, currency,
        total_amount, item_count, file_format, status, created_by)
     VALUES ($1,$2,$3,NULL,$4,$5,'PAYROLL',$6,$7,$8,$9,'DRAFT',$10)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, input.payrollId, batchNo,
      currency, totalAmount, items.rows.length, fileFormat, ctx.userId ?? null,
    ]
  );
  const batchId = Number(batch.rows[0].id);
  for (const it of items.rows) {
    const hasBank = Boolean(it.bank_account_no);
    const hasPhone = Boolean(it.phone);
    const method = hasBank ? 'BANK_TRANSFER' : hasPhone ? 'MOBILE_MONEY' : 'BANK_TRANSFER';
    const masked = hasBank ? '****' + String(it.bank_account_no).slice(-4) : null;
    const mobile = !hasBank && hasPhone ? String(it.phone) : null;
    await client.query(
      `INSERT INTO payment_batch_items
         (company_id, tenant_id, batch_id, employee_id, payment_method, bank_name,
          masked_account_no, mobile_no, amount, currency, payment_reference, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
      [
        ctx.companyId, ctx.tenantId, batchId, Number(it.employee_id), method,
        it.bank_name ?? null, masked, mobile, round2(Number(it.net_pay) || 0),
        String(it.currency ?? currency), String(it.payslip_no),
      ]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.payment_batch_created',
    entityType: 'payment_batches',
    entityId: batchId,
    entityCode: batchNo,
    payload: { payrollId: input.payrollId, payrollNo: String(payroll.payroll_no), totalAmount, itemCount: items.rows.length },
  });
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'payment_batches',
    recordId: batchId,
    recordCode: batchNo,
    newValues: { payrollId: input.payrollId, payrollNo: String(payroll.payroll_no), totalAmount, itemCount: items.rows.length, status: 'DRAFT' },
  });
  return { batchId, batchNo, totalAmount, itemCount: items.rows.length, status: 'DRAFT' };
}

/** Validate a DRAFT batch: item amounts/references and batch-to-payroll totals. */
export async function validatePaymentBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const batch = await loadBatch(client, ctx, batchId);
  if (!['DRAFT', 'FAILED'].includes(String(batch.status))) {
    throw badRequest(`Only DRAFT payment batches can be validated (current: ${batch.status})`);
  }
  const items = await client.query(
    `SELECT * FROM payment_batch_items WHERE batch_id = $1 AND tenant_id = $2`,
    [batchId, ctx.tenantId]
  );
  if (items.rows.length === 0) throw badRequest('Payment batch has no items to validate');
  const notes: { level: string; code: string; message: string }[] = [];
  let amountTotal = 0;
  let itemErrors = 0;
  for (const it of items.rows) {
    const amount = round2(Number(it.amount) || 0);
    amountTotal += amount;
    if (amount <= 0) {
      itemErrors += 1;
      notes.push({ level: 'error', code: 'ZERO_AMOUNT', message: `Employee ${it.employee_id} has a non-positive payment amount` });
    }
    if (!it.payment_reference) {
      itemErrors += 1;
      notes.push({ level: 'error', code: 'MISSING_REFERENCE', message: `Employee ${it.employee_id} has no payment reference` });
    }
    if (String(it.payment_method) === 'BANK_TRANSFER' && !it.masked_account_no) {
      itemErrors += 1;
      notes.push({ level: 'error', code: 'MISSING_BANK_DETAILS', message: `Employee ${it.employee_id} has no bank account for bank transfer` });
    }
  }
  const expected = round2(Number(batch.total_amount) || 0);
  const actual = round2(amountTotal);
  if (Math.abs(actual - expected) > 0.01) {
    notes.push({ level: 'error', code: 'AMOUNT_MISMATCH', message: `Batch total ${actual} does not match payroll net total ${expected}` });
  } else {
    notes.push({ level: 'info', code: 'AMOUNT_OK', message: `Batch total matches payroll net total (${actual})` });
  }
  if (itemErrors > 0 || Math.abs(actual - expected) > 0.01) {
    await client.query(
      `UPDATE payment_batches SET status = 'FAILED', notes = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(notes), batchId]
    );
    throw badRequest(`Payment batch failed validation: ${itemErrors} item error(s), amount mismatch`, notes);
  }
  await client.query(
    `UPDATE payment_batches SET status = 'VALIDATED', notes = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(notes), batchId]
  );
  await logAudit(client, ctx, {
    action: 'validate',
    resource: 'payment_batches',
    recordId: batchId,
    recordCode: String(batch.batch_no),
    newValues: { status: 'VALIDATED', notes },
  });
  return { batchId, batchNo: String(batch.batch_no), status: 'VALIDATED', totalAmount: expected, itemCount: items.rows.length, notes };
}

/** Approve a batch. The batch creator cannot be the approver (separation of duties). */
export async function approvePaymentBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const batch = await loadBatch(client, ctx, batchId);
  if (!['DRAFT', 'VALIDATED'].includes(String(batch.status))) {
    throw badRequest(`Only DRAFT or VALIDATED payment batches can be approved (current: ${batch.status})`);
  }
  if (batch.created_by !== null && Number(batch.created_by) === Number(ctx.userId)) {
    throw badRequest('You cannot approve a payment batch you created (separation of duties)');
  }
  await client.query(
    `UPDATE payment_batches SET status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`,
    [batchId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'payment_batches',
    recordId: batchId,
    recordCode: String(batch.batch_no),
    oldValues: { status: String(batch.status) },
    newValues: { status: 'APPROVED', approvedBy: ctx.userId ?? null },
  });
  return { batchId, batchNo: String(batch.batch_no), status: 'APPROVED', approvedBy: ctx.userId ?? null };
}

/** Export an approved batch (masked payment details only). */
export async function exportPaymentBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const batch = await loadBatch(client, ctx, batchId);
  if (String(batch.status) !== 'APPROVED') {
    throw badRequest(`Only APPROVED payment batches can be exported (current: ${batch.status})`);
  }
  const items = await client.query(
    `SELECT i.*, e.employee_no, e.first_name, e.last_name
     FROM payment_batch_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.batch_id = $1 AND i.tenant_id = $2 ORDER BY e.last_name, e.first_name`,
    [batchId, ctx.tenantId]
  );
  const rows = items.rows.map((r) => ({
    employeeId: Number(r.employee_id),
    employeeNo: String(r.employee_no),
    employeeName: String(`${r.first_name} ${r.last_name}`.trim()),
    paymentMethod: String(r.payment_method),
    bankName: r.bank_name != null ? String(r.bank_name) : null,
    maskedAccountNo: r.masked_account_no != null ? String(r.masked_account_no) : null,
    mobileNo: r.mobile_no != null ? String(r.mobile_no) : null,
    amount: round2(Number(r.amount) || 0),
    currency: String(r.currency ?? 'UGX'),
    paymentReference: r.payment_reference != null ? String(r.payment_reference) : null,
  }));
  const header = ['employee_no', 'employee_name', 'payment_method', 'bank_name', 'masked_account_no', 'mobile_no', 'amount', 'currency', 'payment_reference'];
  const fileContent = [header.join(',')]
    .concat(
      rows.map((r) =>
        [r.employeeNo, `"${r.employeeName}"`, r.paymentMethod, r.bankName ?? '', r.maskedAccountNo ?? '', r.mobileNo ?? '', r.amount, r.currency, r.paymentReference ?? ''].join(',')
      )
    )
    .join('\n');
  await client.query(
    `UPDATE payment_batches SET status = 'EXPORTED', exported_by = $2, exported_at = now(), updated_at = now() WHERE id = $1`,
    [batchId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'export',
    resource: 'payment_batches',
    recordId: batchId,
    recordCode: String(batch.batch_no),
    oldValues: { status: 'APPROVED' },
    newValues: { status: 'EXPORTED', exportedBy: ctx.userId ?? null, rowCount: rows.length },
  });
  return { batchId, batchNo: String(batch.batch_no), status: 'EXPORTED', exportedBy: ctx.userId ?? null, fileFormat: batch.file_format ?? null, rowCount: rows.length, rows, fileContent };
}

/** Confirm payment: mark items PAID and record successful bank/mobile transactions. */
export async function confirmPaymentBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const batch = await loadBatch(client, ctx, batchId);
  if (String(batch.status) !== 'EXPORTED') {
    throw badRequest(`Only EXPORTED payment batches can be confirmed (current: ${batch.status})`);
  }
  const items = await client.query(
    `SELECT * FROM payment_batch_items WHERE batch_id = $1 AND tenant_id = $2 AND status = 'PENDING'`,
    [batchId, ctx.tenantId]
  );
  if (items.rows.length === 0) throw badRequest('Payment batch has no pending items to confirm');
  const batchNo = String(batch.batch_no);
  let seq = 0;
  for (const it of items.rows) {
    seq += 1;
    const channel = String(it.payment_method) === 'MOBILE_MONEY' ? 'MOBILE_MONEY' : 'BANK';
    await client.query(
      `INSERT INTO payment_transactions
         (company_id, tenant_id, batch_id, item_id, employee_id, transaction_ref, amount, currency,
          channel, status, raw_response, processed_at, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUCCESS',$10,now(),$11)`,
      [
        ctx.companyId, ctx.tenantId, batchId, Number(it.id), Number(it.employee_id),
        `${batchNo}-${String(seq).padStart(3, '0')}`, round2(Number(it.amount) || 0),
        String(it.currency ?? batch.currency ?? 'UGX'), channel,
        JSON.stringify({ confirmed: true, reference: it.payment_reference != null ? String(it.payment_reference) : '' }),
        ctx.userId ?? null,
      ]
    );
    await client.query(`UPDATE payment_batch_items SET status = 'PAID' WHERE id = $1`, [Number(it.id)]);
  }
  await client.query(
    `UPDATE payment_batches SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`,
    [batchId, ctx.userId ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.payment_confirmed',
    entityType: 'payment_batches',
    entityId: batchId,
    entityCode: batchNo,
    payload: { transactionCount: items.rows.length, totalAmount: round2(Number(batch.total_amount) || 0) },
  });
  await logAudit(client, ctx, {
    action: 'confirm',
    resource: 'payment_batches',
    recordId: batchId,
    recordCode: batchNo,
    newValues: { status: 'CONFIRMED', transactionCount: items.rows.length, confirmedBy: ctx.userId ?? null },
  });
  return { batchId, batchNo, status: 'CONFIRMED', totalAmount: round2(Number(batch.total_amount) || 0), transactionCount: items.rows.length };
}

export async function listPaymentBatches(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string; payrollId?: number; q?: string; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['b.tenant_id = $1', 'b.company_id = $2'];
  if (filters.status) {
    params.push(filters.status);
    where.push('b.status = $' + params.length);
  }
  if (filters.payrollId) {
    params.push(filters.payrollId);
    where.push('b.payroll_id = $' + params.length);
  }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(b.batch_no ILIKE $' + params.length + ' OR p.payroll_no ILIKE $' + params.length + ')');
  }
  params.push(pageSize, offset);
  const res = await client.query(
    `SELECT b.id, b.batch_no, b.batch_type, b.currency, b.total_amount, b.item_count, b.file_format,
            b.status, b.created_by, b.approved_by, b.approved_at, b.exported_at, b.confirmed_at,
            b.created_at, b.updated_at,
            p.id AS payroll_id, p.payroll_no, p.period_start, p.period_end, p.status AS payroll_status
     FROM payment_batches b
     LEFT JOIN payrolls p ON p.id = b.payroll_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.periodStart = toISODate(r.period_start);
    out.periodEnd = toISODate(r.period_end);
    return out;
  });
  const count = await client.query(
    `SELECT count(*)::int AS n FROM payment_batches b
     LEFT JOIN payrolls p ON p.id = b.payroll_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows, page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

export async function getPaymentBatch(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const res = await client.query(
    `SELECT * FROM payment_batches WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payment batch not found');
  const items = await client.query(
    `SELECT i.id, i.employee_id, i.payment_method, i.bank_name, i.masked_account_no, i.mobile_no,
            i.amount, i.currency, i.payment_reference, i.status,
            e.employee_no, e.first_name, e.last_name
     FROM payment_batch_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.batch_id = $1 AND i.tenant_id = $2 ORDER BY e.last_name, e.first_name`,
    [batchId, ctx.tenantId]
  );
  const transactions = await client.query(
    `SELECT id, item_id, employee_id, transaction_ref, amount, currency, channel, status, raw_response,
            processed_at, processed_by, created_at
     FROM payment_transactions WHERE batch_id = $1 AND tenant_id = $2 ORDER BY id`,
    [batchId, ctx.tenantId]
  );
  const payroll = res.rows[0].payroll_id != null
    ? await client.query(
        `SELECT id, payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total, currency
         FROM payrolls WHERE id = $1 AND tenant_id = $2`,
        [Number(res.rows[0].payroll_id), ctx.tenantId]
      )
    : { rows: [] };
  const detail = toCamelRow(res.rows[0]);
  detail.items = toCamelRows(items.rows);
  detail.transactions = toCamelRows(transactions.rows);
  detail.payroll = payroll.rows.length > 0 ? toCamelRow(payroll.rows[0]) : null;
  return detail;
}

/** Publish payslips for a released payroll (idempotent per employee). */
export async function publishPayslips(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const payroll = await loadPayroll(client, ctx, payrollId);
  if (!['RELEASED', 'PAID'].includes(String(payroll.status))) {
    throw badRequest(`Payslips can only be published after the payroll is released (current: ${payroll.status})`);
  }
  const periodEnd = toISODate(payroll.period_end) ?? '';
  const items = await client.query(
    `SELECT i.*, e.employee_no
     FROM payroll_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.payroll_id = $1 ORDER BY e.last_name, e.first_name`,
    [payrollId]
  );
  let published = 0;
  let skipped = 0;
  for (const it of items.rows) {
    const existing = await client.query(
      `SELECT id FROM payslips WHERE payroll_id = $1 AND employee_id = $2 AND tenant_id = $3`,
      [payrollId, Number(it.employee_id), ctx.tenantId]
    );
    if (existing.rows.length > 0) {
      skipped += 1;
      continue;
    }
    const payslipNo = String(it.payslip_no ?? '');
    const verificationCode = createHash('sha256')
      .update(`${String(payroll.payroll_no)}:${String(it.employee_no ?? '')}:${periodEnd}`)
      .digest('hex')
      .slice(0, 10);
    await client.query(
      `INSERT INTO payslips
         (company_id, tenant_id, payroll_run_id, run_employee_id, payroll_id, employee_id, payslip_no,
          currency, gross_total, taxable_total, deduction_total, net_total, employer_contributions,
          payment_date, verification_code, published_at, published_by, watermark, status)
       VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14,NULL,'PUBLISHED')`,
      [
        ctx.companyId, ctx.tenantId, payrollId, Number(it.employee_id), payslipNo,
        String(it.currency ?? payroll.currency ?? 'UGX'),
        round2(Number(it.gross_pay) || 0),
        round2(Number(it.taxable_income) || 0),
        round2(Number(it.total_deductions) || 0),
        round2(Number(it.net_pay) || 0),
        round2(Number(it.employer_nssf) || 0),
        toISODate(payroll.payment_date),
        verificationCode,
        ctx.userId ?? null,
      ]
    );
    published += 1;
  }
  await logAudit(client, ctx, {
    action: 'publish-payslips',
    resource: 'payslips',
    recordId: payrollId,
    recordCode: String(payroll.payroll_no),
    newValues: { published, skipped, periodStart: toISODate(payroll.period_start), periodEnd },
  });
  return { payrollId, payrollNo: String(payroll.payroll_no), published, skipped };
}

export async function listPayslips(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { payrollId?: number; employeeId?: number; q?: string; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['s.tenant_id = $1', 's.company_id = $2'];
  if (filters.payrollId) {
    params.push(filters.payrollId);
    where.push('s.payroll_id = $' + params.length);
  }
  if (filters.employeeId) {
    params.push(filters.employeeId);
    where.push('s.employee_id = $' + params.length);
  }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(s.payslip_no ILIKE $' + params.length + ' OR e.employee_no ILIKE $' + params.length + ' OR e.first_name ILIKE $' + params.length + ' OR e.last_name ILIKE $' + params.length + ')');
  }
  params.push(pageSize, offset);
  const res = await client.query(
    `SELECT s.id, s.payslip_no, s.currency, s.gross_total, s.taxable_total, s.deduction_total,
            s.net_total, s.employer_contributions, s.payment_date, s.verification_code,
            s.status, s.published_at, s.viewed_at, s.viewed_count, s.download_count, s.watermark,
            s.payroll_id, s.employee_id, e.employee_no, e.first_name, e.last_name, e.position
     FROM payslips s JOIN employees e ON e.id = s.employee_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.paymentDate = toISODate(r.payment_date);
    return out;
  });
  const count = await client.query(
    `SELECT count(*)::int AS n FROM payslips s JOIN employees e ON e.id = s.employee_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows, page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

/** Reconcile a confirmed payment batch against payroll, bank and GL totals. */
export async function reconcilePayments(client: pg.PoolClient, ctx: Ctx, input: { payrollId: number }) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const payroll = await loadPayroll(client, ctx, input.payrollId);
  const existing = await client.query(
    `SELECT id, status FROM payment_reconciliations WHERE payroll_id = $1 AND tenant_id = $2`,
    [input.payrollId, ctx.tenantId]
  );
  if (existing.rows.length > 0) {
    throw badRequest(`Payroll already reconciled (reconciliation ${existing.rows[0].id}, status ${existing.rows[0].status})`);
  }
  const batch = await client.query(
    `SELECT * FROM payment_batches WHERE payroll_id = $1 AND tenant_id = $2 AND status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`,
    [input.payrollId, ctx.tenantId]
  );
  if (batch.rows.length === 0) {
    throw badRequest('Payroll has no confirmed payment batch to reconcile');
  }
  const b = batch.rows[0];
  const payrollTotal = round2(Number(payroll.net_total) || 0);
  const batchTotal = round2(Number(b.total_amount) || 0);
  const bank = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions
     WHERE batch_id = $1 AND tenant_id = $2 AND status = 'SUCCESS'`,
    [Number(b.id), ctx.tenantId]
  );
  const bankTotal = round2(Number(bank.rows[0].total) || 0);
  let journalTotal: number | null = null;
  if (payroll.gl_journal_id != null) {
    const journal = await client.query(
      `SELECT COALESCE(SUM(credit),0)::numeric AS total
       FROM journal_lines
       WHERE entry_id = $1 AND description LIKE 'Net pay %'`,
      [Number(payroll.gl_journal_id)]
    );
    journalTotal = round2(Number(journal.rows[0].total) || 0);
  }
  const differences: { key: string; expected: number | null; actual: number | null; delta: number | null; status: string }[] = [];
  const diff = (key: string, expected: number | null, actual: number | null) => {
    if (expected === null || actual === null) {
      differences.push({ key, expected, actual, delta: null, status: 'MISSING' });
      return;
    }
    if (Math.abs(expected - actual) > 0.01) {
      differences.push({ key, expected, actual, delta: round2(actual - expected), status: 'MISMATCH' });
    }
  };
  diff('batch', payrollTotal, batchTotal);
  diff('bank', batchTotal, bankTotal);
  diff('journal', payrollTotal, journalTotal);
  const matched = differences.length === 0;
  const status = matched ? 'MATCHED' : 'DIFFERENCE';
  const journalEntryId = payroll.gl_journal_id != null ? Number(payroll.gl_journal_id) : null;
  const ins = await client.query(
    `INSERT INTO payment_reconciliations
       (company_id, tenant_id, payroll_run_id, payroll_id, batch_id, journal_entry_id,
        payroll_total, batch_total, bank_total, journal_total, status, differences, reconciled_by, reconciled_at)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.payrollId, Number(b.id), journalEntryId,
      payrollTotal, batchTotal, bankTotal, journalTotal ?? 0, status,
      JSON.stringify(differences), ctx.userId ?? null,
    ]
  );
  if (matched) {
    await client.query(
      `UPDATE payment_batches SET status = 'RECONCILED', updated_at = now() WHERE id = $1`,
      [Number(b.id)]
    );
  }
  await logAudit(client, ctx, {
    action: 'reconcile',
    resource: 'payment_reconciliations',
    recordId: Number(ins.rows[0].id),
    recordCode: String(payroll.payroll_no),
    newValues: { batchId: Number(b.id), batchNo: String(b.batch_no), status, payrollTotal, batchTotal, bankTotal, journalTotal, differences },
  });
  return {
    reconciliationId: Number(ins.rows[0].id),
    status,
    payrollTotal,
    batchTotal,
    bankTotal,
    journalTotal,
    differences,
  };
}

/** Reconciliation centre: batch status counts, transaction health and recent rows. */
export async function reconciliationCentre(client: pg.PoolClient, ctx: Ctx) {
  const batches = await client.query(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS amount
     FROM payment_batches WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  const transactions = await client.query(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS amount
     FROM payment_transactions WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  const reconciliations = await client.query(
    `SELECT status, count(*)::int AS n FROM payment_reconciliations
     WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  const recent = await client.query(
    `SELECT r.id, r.batch_id, r.payroll_id, r.status, r.payroll_total, r.batch_total, r.bank_total,
            r.journal_total, r.differences, r.reconciled_at, b.batch_no, p.payroll_no
     FROM payment_reconciliations r
     LEFT JOIN payment_batches b ON b.id = r.batch_id
     LEFT JOIN payrolls p ON p.id = r.payroll_id
     WHERE r.tenant_id = $1 AND r.company_id = $2
     ORDER BY r.id DESC LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    batches: toCamelRows(batches.rows),
    transactions: toCamelRows(transactions.rows),
    reconciliations: toCamelRows(reconciliations.rows),
    recent: toCamelRows(recent.rows),
  };
}

/** Payment dashboard KPIs: paid/failed totals and batch pipeline status. */
export async function paymentDashboard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM payment_batches WHERE tenant_id = $1 AND company_id = $2)::int AS total_batches,
       (SELECT count(*) FROM payment_batches WHERE tenant_id = $1 AND company_id = $2 AND status = 'RECONCILED')::int AS reconciled_batches,
       (SELECT count(*) FROM payment_transactions WHERE tenant_id = $1 AND company_id = $2 AND status = 'SUCCESS')::int AS paid_transactions,
       (SELECT count(*) FROM payment_transactions WHERE tenant_id = $1 AND company_id = $2 AND status = 'FAILED')::int AS failed_transactions,
       (SELECT count(DISTINCT employee_id) FROM payment_transactions WHERE tenant_id = $1 AND company_id = $2 AND status = 'SUCCESS')::int AS employees_paid,
       (SELECT COALESCE(SUM(amount),0) FROM payment_transactions WHERE tenant_id = $1 AND company_id = $2 AND status = 'SUCCESS')::numeric AS total_paid,
       (SELECT COALESCE(SUM(total_amount),0) FROM payment_batches WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','EXPORTED','CONFIRMED'))::numeric AS outstanding_amount,
       (SELECT COALESCE(SUM(net_total),0) FROM payrolls WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','RELEASED','PAID'))::numeric AS payroll_net_total`,
    [ctx.tenantId, ctx.companyId]
  );
  const byStatus = await client.query(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS amount
     FROM payment_batches WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  return { kpis: toCamelRow(kpis.rows[0]), byStatus: toCamelRows(byStatus.rows) };
}
