// ============================================================
// Advanced Finance & Accounting - HOPE DESIGN GROUP LTD
// Journal workflow lifecycle, configurable posting rules engine,
// Uganda tax engine + URA EFRIS adapter, budget control,
// manufacturing costing, intercompany / consolidation,
// period close cockpit, financial audit trail.
// ============================================================
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, forbidden, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { getAccountId, postJournalLines, budgetPosition } from './finance.js';

const n = (v: unknown): number => Number(v) || 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;

function isoDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

const randCode = (len: number): string =>
  randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();

function renderTemplate(tpl: string, vars: Record<string, number>): string {
  return String(tpl ?? '0').replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? 0));
}

/** Immutable financial audit log (ordinary users cannot write to this). */
async function finAudit(
  client: pg.PoolClient,
  ctx: Ctx,
  entry: {
    action: string; module: string; docType?: string | null; docId?: number | null;
    docCode?: string | null; previousValue?: unknown; newValue?: unknown;
  }
) {
  await client.query(
    `INSERT INTO financial_audit_logs
       (tenant_id, company_id, user_id, action, module, doc_type, doc_id, doc_code,
        previous_value, new_value, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    [
      ctx.tenantId ?? null, ctx.companyId ?? null, ctx.userId ?? null, entry.action, entry.module,
      entry.docType ?? null, entry.docId ?? null, entry.docCode ?? null,
      entry.previousValue ? JSON.stringify(entry.previousValue) : null,
      entry.newValue ? JSON.stringify(entry.newValue) : null,
      ctx.ip ?? null, ctx.userAgent ?? null,
    ]
  );
}

async function nextDocNo(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}// ---------- 1. Journal workflow lifecycle (DRAFT -> APPROVED -> POSTED) ----------
export async function createJournalDraft(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    entryDate: string;
    description: string;
    journalType?: string;
    lines: Array<{
      accountId: number;
      debit?: number;
      credit?: number;
      costCentreId?: number | null;
      profitCentreId?: number | null;
      description?: string;
    }>;
    isTemplate?: boolean;
    isRecurring?: boolean;
    recurringFrequency?: string;
    reverseOnPost?: boolean;
  }
) {
  if (!input.lines || input.lines.length < 2) throw badRequest('A journal needs at least two lines');
  const debit = input.lines.reduce((s, l) => s + n(l.debit), 0);
  const credit = input.lines.reduce((s, l) => s + n(l.credit), 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw badRequest(`Journal does not balance: debit ${debit} vs credit ${credit}`);
  }
  if (debit <= 0) throw badRequest('Journal amount must be positive');
  const entryDate = isoDate(input.entryDate);
  const periodRes = await client.query(
    `SELECT id FROM financial_periods
     WHERE company_id = $1 AND start_date <= $2::date AND end_date >= $2::date
       AND status IN ('OPEN','SOFT_CLOSE') ORDER BY start_date LIMIT 1`,
    [ctx.companyId, entryDate]
  );
  if (!periodRes.rows.length) throw badRequest(`No open financial period covers ${entryDate}`);
  const periodId = Number(periodRes.rows[0].id);
  const entryNo = await nextDocNo(client, ctx, 'GL');
  const ins = await client.query(
    `INSERT INTO journal_entries
       (company_id, tenant_id, branch_id, entry_no, entry_date, period_id, journal_type,
        description, currency, exchange_rate, total_debit, total_credit, status,
        is_template, is_recurring, recurring_frequency, reverse_on_post)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UGX',1,$9,$10,'DRAFT',$11,$12,$13,$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, entryNo, entryDate, periodId,
      input.journalType ?? 'MANUAL', input.description, debit, credit,
      Boolean(input.isTemplate), Boolean(input.isRecurring),
      input.recurringFrequency ?? null, Boolean(input.reverseOnPost),
    ]
  );
  const entryId = Number(ins.rows[0].id);
  for (const l of input.lines) {
    await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, cost_centre_id, profit_centre_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entryId, Number(l.accountId), l.costCentreId ?? null, l.profitCentreId ?? null,
       n(l.debit), n(l.credit), l.description ?? input.description]
    );
  }
  await finAudit(client, ctx, {
    action: 'JOURNAL_CREATED', module: 'finance', docType: 'JOURNAL_ENTRY', docId: entryId, docCode: entryNo,
    newValue: { journalType: input.journalType ?? 'MANUAL', totalDebit: debit, totalCredit: credit },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.journal.created', entityType: 'JOURNAL_ENTRY', entityId: entryId,
    entityCode: entryNo, payload: { status: 'DRAFT' },
  });
  return { entryId, entryNo, status: 'DRAFT' };
}

/** Maker of a journal - derived from the immutable financial audit log. */
async function journalCreator(client: pg.PoolClient, id: number): Promise<number | null> {
  const res = await client.query(
    `SELECT user_id FROM financial_audit_logs
     WHERE module='finance' AND doc_type='JOURNAL_ENTRY' AND doc_id=$1 AND action='JOURNAL_DRAFT'
     ORDER BY id LIMIT 1`,
    [id]
  );
  return res.rows.length ? Number(res.rows[0].user_id) : null;
}

async function getJournalForUpdate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM journal_entries WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Journal entry not found');
  return res.rows[0];
}

export async function submitJournal(client: pg.PoolClient, ctx: Ctx, id: number) {
  const j = await getJournalForUpdate(client, ctx, id);
  if (j.status !== 'DRAFT') throw badRequest(`Journal ${j.entry_no} is ${j.status}; only drafts can be submitted`);
  await client.query(
    `UPDATE journal_entries SET status='SUBMITTED', submitted_by=$2, submitted_at=now() WHERE id=$1`,
    [id, ctx.userId ?? null]
  );
  await finAudit(client, ctx, {
    action: 'JOURNAL_SUBMITTED', module: 'finance', docType: 'JOURNAL_ENTRY', docId: id,
    docCode: String(j.entry_no), previousValue: { status: j.status }, newValue: { status: 'SUBMITTED' },
  });
  return { entryId: id, entryNo: String(j.entry_no), status: 'SUBMITTED' };
}export async function approveJournal(client: pg.PoolClient, ctx: Ctx, id: number) {
  const j = await getJournalForUpdate(client, ctx, id);
  if (!['SUBMITTED', 'PENDING_APPROVAL'].includes(j.status)) {
    throw badRequest(`Journal ${j.entry_no} is ${j.status}; only submitted journals can be approved`);
  }
  const creator = await journalCreator(client, id);
  if (creator !== null && creator === ctx.userId) {
    throw forbidden('Segregation of duties: the maker cannot approve their own journal');
  }
  await client.query(
    `UPDATE journal_entries SET status='APPROVED', approved_by=$2, approved_at=now() WHERE id=$1`,
    [id, ctx.userId ?? null]
  );
  await finAudit(client, ctx, {
    action: 'JOURNAL_APPROVED', module: 'finance', docType: 'JOURNAL_ENTRY', docId: id,
    docCode: String(j.entry_no), previousValue: { status: j.status }, newValue: { status: 'APPROVED' },
  });
  return { entryId: id, entryNo: String(j.entry_no), status: 'APPROVED' };
}

export async function rejectJournal(client: pg.PoolClient, ctx: Ctx, id: number, reason: string) {
  const j = await getJournalForUpdate(client, ctx, id);
  if (!['SUBMITTED', 'PENDING_APPROVAL'].includes(j.status)) {
    throw badRequest(`Journal ${j.entry_no} is ${j.status}; only submitted journals can be rejected`);
  }
  const creator = await journalCreator(client, id);
  if (creator !== null && creator === ctx.userId) {
    throw forbidden('Segregation of duties: the maker cannot reject their own journal');
  }
  await client.query(
    `UPDATE journal_entries
        SET status='REJECTED', rejected_by=$2, rejected_at=now(), rejection_reason=$3
      WHERE id=$1`,
    [id, ctx.userId ?? null, reason ?? 'Rejected']
  );
  await finAudit(client, ctx, {
    action: 'JOURNAL_REJECTED', module: 'finance', docType: 'JOURNAL_ENTRY', docId: id,
    docCode: String(j.entry_no), previousValue: { status: j.status }, newValue: { status: 'REJECTED', reason },
  });
  return { entryId: id, entryNo: String(j.entry_no), status: 'REJECTED' };
}

/** Post via the SQL invariant post_journal_entry (balance, >=2 lines, open period). */
export async function postJournalWorkflow(client: pg.PoolClient, ctx: Ctx, id: number) {
  const j = await getJournalForUpdate(client, ctx, id);
  if (!['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'].includes(j.status)) {
    throw badRequest(`Journal ${j.entry_no} is ${j.status}; it cannot be posted`);
  }
  if (j.approved_by !== null && Number(j.approved_by) === ctx.userId) {
    throw forbidden('Segregation of duties: the approver cannot post the same journal');
  }
  await client.query(`SELECT post_journal_entry($1,$2)`, [id, ctx.userId ?? null]);
  await emitEvent(client, ctx, {
    eventType: 'finance.journal.posted', entityType: 'JOURNAL_ENTRY', entityId: id,
    entityCode: String(j.entry_no), payload: { status: 'POSTED' },
  });
  return { entryId: id, entryNo: String(j.entry_no), status: 'POSTED' };
}

/** Reversal via the SQL reverse_journal function (creates offsetting entry). */
export async function reverseJournalWorkflow(client: pg.PoolClient, ctx: Ctx, id: number, reason: string) {
  const j = await getJournalForUpdate(client, ctx, id);
  if (j.status !== 'POSTED') {
    throw badRequest(`Only posted journals can be reversed; ${j.entry_no} is ${j.status}`);
  }
  const rev = await client.query(`SELECT reverse_journal($1,$2,$3) AS reversal_id`, [id, ctx.userId ?? null, reason ?? 'Correction']);
  const reversalId = Number(rev.rows[0].reversal_id);
  await finAudit(client, ctx, {
    action: 'JOURNAL_REVERSED', module: 'finance', docType: 'JOURNAL_ENTRY', docId: id,
    docCode: String(j.entry_no), previousValue: { status: j.status },
    newValue: { status: 'REVERSED', reversalId, reason },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.journal.reversed', entityType: 'JOURNAL_ENTRY', entityId: id,
    entityCode: String(j.entry_no), payload: { status: 'REVERSED', reversalId },
  });
  return { entryId: id, entryNo: String(j.entry_no), status: 'REVERSED', reversalId };
}// ---------- 2. Journal templates + configurable posting rules ----------
export async function listJournalTemplates(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM journal_templates WHERE tenant_id=$1 AND company_id=$2 ORDER BY code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createJournalTemplate(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; name: string; journalType?: string; description?: string; lines: unknown[] }
) {
  const res = await client.query(
    `INSERT INTO journal_templates (company_id, tenant_id, code, name, journal_type, description, lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.code, input.name, input.journalType ?? 'MANUAL',
     input.description ?? null, JSON.stringify(input.lines ?? [])]
  );
  return toCamelRow(res.rows[0]);
}

export async function listPostingRules(client: pg.PoolClient, ctx: Ctx, filters: { event?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE pr.tenant_id = $1 AND pr.company_id = $2';
  if (filters.event) {
    params.push(filters.event);
    where += ` AND pr.event = $${params.length}`;
  }
  const res = await client.query(`SELECT pr.* FROM posting_rules pr ${where} ORDER BY pr.event, pr.code`, params);
  return toCamelRows(res.rows);
}

export async function createPostingRule(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { event: string; code: string; name: string; journalType?: string; lines: unknown[] }
) {
  const res = await client.query(
    `INSERT INTO posting_rules (company_id, tenant_id, event, code, name, journal_type, lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.event, input.code, input.name, input.journalType ?? 'MANUAL',
     JSON.stringify(input.lines ?? [])]
  );
  await finAudit(client, ctx, {
    action: 'POSTING_RULE_CREATED', module: 'finance', docType: 'POSTING_RULE', docId: Number(res.rows[0].id),
    docCode: input.code, newValue: { event: input.event, lines: input.lines ?? [] },
  });
  return toCamelRow(res.rows[0]);
}

/**
 * Render a posting rule against a business event and post the resulting
 * double-entry journal. Placeholders {{amount}}, {{net}}, {{tax}} are
 * resolved at runtime; account codes are resolved to the company COA.
 */
export async function applyPostingRule(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    event: string;
    code?: string;
    amount: number;
    net?: number;
    tax?: number;
    entryDate?: string;
    description?: string;
    refType?: string | null;
    refId?: number | null;
    refCode?: string | null;
  }
) {
  const params: unknown[] = [ctx.companyId, input.event];
  let sql = 'SELECT * FROM posting_rules WHERE company_id=$1 AND event=$2 AND is_active=true';
  if (input.code) {
    params.push(input.code);
    sql += ` AND code=$${params.length}`;
  }
  sql += ' ORDER BY id LIMIT 1';
  const ruleRes = await client.query(sql, params);
  if (!ruleRes.rows.length) {
    throw badRequest(`No active posting rule for event ${input.event}${input.code ? ` (${input.code})` : ''}`);
  }
  const rule = ruleRes.rows[0];
  const vars = { amount: n(input.amount), net: n(input.net), tax: n(input.tax) };
  const rendered: Array<{ account_id: number; debit: number; credit: number }> = [];
  for (const ln of rule.lines ?? []) {
    rendered.push({
      account_id: await getAccountId(client, ctx, String(ln.account_code ?? '')),
      debit: Number(renderTemplate(ln.debit ?? '0', vars)),
      credit: Number(renderTemplate(ln.credit ?? '0', vars)),
    });
  }
  if (rendered.length < 2) throw badRequest('Posting rule produced fewer than two lines');
  const dr = rendered.reduce((s, l) => s + n(l.debit), 0);
  const cr = rendered.reduce((s, l) => s + n(l.credit), 0);
  if (Math.round(dr * 100) !== Math.round(cr * 100)) {
    throw badRequest(`Posting rule ${rule.code} does not balance: debit ${dr} vs credit ${cr}`);
  }
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(input.entryDate),
    journalType: String(rule.journal_type ?? 'MANUAL'),
    description: input.description ?? String(rule.name),
    lines: rendered,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    refCode: input.refCode ?? null,
  });
  return { entryId, rule: toCamelRow(rule), lines: rendered };
}// ---------- 3. Configurable tax engine (Uganda: VAT/WHT/Excise) ----------
export async function listTaxes(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM taxes WHERE tenant_id=$1 AND company_id=$2 AND is_active=true ORDER BY code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function listTaxJurisdictions(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM tax_jurisdictions WHERE tenant_id=$1 AND company_id=$2 ORDER BY code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createTaxJurisdiction(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; name: string; country?: string }
) {
  const res = await client.query(
    `INSERT INTO tax_jurisdictions (company_id, tenant_id, code, name, country)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.code, input.name, input.country ?? 'UG']
  );
  return toCamelRow(res.rows[0]);
}

export async function listTaxRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name,
            t.code AS tax_code, t.name AS tax_name, t.rate AS tax_rate
     FROM tax_rules tr
     JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
     JOIN taxes t ON t.id = tr.tax_id
     WHERE tr.tenant_id=$1 AND tr.company_id=$2 ORDER BY tj.code, t.code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createTaxRule(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    jurisdictionId: number; taxId: number; appliesTo?: string;
    rateOverride?: number | null; thresholdAmount?: number | null;
  }
) {
  const res = await client.query(
    `INSERT INTO tax_rules (company_id, tenant_id, jurisdiction_id, tax_id, applies_to, rate_override, threshold_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.companyId, ctx.tenantId, Number(input.jurisdictionId), Number(input.taxId),
     input.appliesTo ?? 'BOTH', input.rateOverride ?? null, input.thresholdAmount ?? null]
  );
  return toCamelRow(res.rows[0]);
}

export async function recordTaxTransaction(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    taxId: number; jurisdictionId?: number | null; docType: string;
    docRefType?: string | null; docRefId?: number | null; docRefCode?: string | null;
    txnDate?: string; baseAmount: number; taxAmount?: number; rate?: number | null;
  }
) {
  const taxRes = await client.query(`SELECT * FROM taxes WHERE id=$1 AND tenant_id=$2`, [Number(input.taxId), ctx.tenantId]);
  if (!taxRes.rows.length) throw notFound('Tax code not found');
  const tax = taxRes.rows[0];
  const txnDate = isoDate(input.txnDate);
  const rate = input.rate != null ? Number(input.rate) : Number(tax.rate);
  const taxAmount = input.taxAmount != null ? Number(input.taxAmount) : round2((n(input.baseAmount) * rate) / 100);
  const periodRes = await client.query(
    `SELECT id FROM financial_periods WHERE company_id=$1 AND start_date<=$2::date AND end_date>=$2::date ORDER BY start_date LIMIT 1`,
    [ctx.companyId, txnDate]
  );
  const periodId = periodRes.rows.length ? Number(periodRes.rows[0].id) : null;
  const existing = await client.query(
    `SELECT id FROM tax_transactions
     WHERE tenant_id=$1 AND doc_type=$2 AND doc_ref_type IS NOT DISTINCT FROM $3
       AND doc_ref_id IS NOT DISTINCT FROM $4 AND tax_id=$5`,
    [ctx.tenantId, input.docType, input.docRefType ?? null, input.docRefId ?? null, Number(input.taxId)]
  );
  let row: Record<string, unknown>;
  if (existing.rows.length) {
    const upd = await client.query(
      `UPDATE tax_transactions SET base_amount=$2, tax_amount=$3, rate=$4, status='POSTED'
       WHERE id=$1 RETURNING *`,
      [existing.rows[0].id, n(input.baseAmount), taxAmount, rate]
    );
    row = upd.rows[0];
  } else {
    const ins = await client.query(
      `INSERT INTO tax_transactions
         (company_id, tenant_id, tax_id, jurisdiction_id, doc_type, doc_ref_type, doc_ref_id,
          doc_ref_code, txn_date, base_amount, tax_amount, rate, period_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ctx.companyId, ctx.tenantId, Number(input.taxId), input.jurisdictionId ?? null, input.docType,
       input.docRefType ?? null, input.docRefId ?? null, input.docRefCode ?? null, txnDate,
       n(input.baseAmount), taxAmount, rate, periodId]
    );
    row = ins.rows[0];
  }
  await finAudit(client, ctx, {
    action: 'TAX_TRANSACTION_POSTED', module: 'tax', docType: input.docType,
    docId: input.docRefId ?? null, docCode: input.docRefCode ?? null,
    newValue: { taxId: Number(input.taxId), baseAmount: n(input.baseAmount), taxAmount, rate },
  });
  return toCamelRow(row);
}

export async function listTaxTransactions(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { from?: string; to?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE tt.tenant_id = $1 AND tt.company_id = $2';
  if (filters.from) { params.push(filters.from); where += ` AND tt.txn_date >= $${params.length}::date`; }
  if (filters.to) { params.push(filters.to); where += ` AND tt.txn_date <= $${params.length}::date`; }
  const res = await client.query(
    `SELECT tt.*, t.code AS tax_code, t.name AS tax_name, tj.code AS jurisdiction_code
     FROM tax_transactions tt
     JOIN taxes t ON t.id = tt.tax_id
     LEFT JOIN tax_jurisdictions tj ON tj.id = tt.jurisdiction_id
     ${where} ORDER BY tt.txn_date DESC, tt.id DESC`,
    params
  );
  return toCamelRows(res.rows);
}

export async function taxComplianceSummary(client: pg.PoolClient, ctx: Ctx, from?: string, to?: string) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE tt.tenant_id = $1 AND tt.company_id = $2';
  if (from) { params.push(from); where += ` AND tt.txn_date >= $${params.length}::date`; }
  if (to) { params.push(to); where += ` AND tt.txn_date <= $${params.length}::date`; }
  const res = await client.query(
    `SELECT t.code AS tax_code, t.name AS tax_name, t.tax_type,
            COUNT(*)::int AS txn_count, SUM(tt.base_amount)::numeric AS base_amount,
            SUM(tt.tax_amount)::numeric AS tax_amount
     FROM tax_transactions tt
     JOIN taxes t ON t.id = tt.tax_id
     ${where} GROUP BY t.id ORDER BY t.code`,
    params
  );
  return toCamelRows(res.rows);
}
// ---------- 4. URA EFRIS integration (ERP records and fiscal records linked but separate) ----------
export async function listEfrisTransactions(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string; from?: string; to?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE tenant_id = $1 AND company_id = $2';
  if (filters.status) { params.push(filters.status); where += ` AND status = $${params.length}`; }
  if (filters.from) { params.push(filters.from); where += ` AND txn_date >= $${params.length}::date`; }
  if (filters.to) { params.push(filters.to); where += ` AND txn_date <= $${params.length}::date`; }
  const res = await client.query(`SELECT * FROM efris_transactions ${where} ORDER BY created_at DESC, id DESC`, params);
  return toCamelRows(res.rows);
}

/**
 * Register an ERP document (e.g. a posted sales invoice) for fiscalisation.
 * Idempotent on idempotency_key - retries return the existing transaction and
 * can never create duplicate fiscal documents.
 */
export async function registerEfrisDocument(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    docType: string; docRefType: string; docRefId: number; docRefCode: string;
    txnDate?: string; currency?: string; grossAmount: number; taxAmount?: number;
    idempotencyKey: string;
  }
) {
  if (!input.idempotencyKey) throw badRequest('EFRIS idempotency_key is required');
  const existing = await client.query(
    `SELECT * FROM efris_transactions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, input.idempotencyKey]
  );
  if (existing.rows.length) return toCamelRow(existing.rows[0]);
  const ins = await client.query(
    `INSERT INTO efris_transactions
       (company_id, tenant_id, doc_type, doc_ref_type, doc_ref_id, doc_ref_code, txn_date,
        currency, gross_amount, tax_amount, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING') RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.docType, input.docRefType, Number(input.docRefId),
     input.docRefCode, isoDate(input.txnDate), input.currency ?? 'UGX',
     n(input.grossAmount), n(input.taxAmount), input.idempotencyKey]
  );
  const row = ins.rows[0];
  await finAudit(client, ctx, {
    action: 'EFRIS_REGISTERED', module: 'efris', docType: input.docType, docId: Number(row.id),
    docCode: input.docRefCode, newValue: { status: 'PENDING', idempotencyKey: input.idempotencyKey },
  });
  await emitEvent(client, ctx, {
    eventType: 'efris.registered', entityType: 'EFRIS_TRANSACTION', entityId: Number(row.id),
    entityCode: input.docRefCode, payload: { status: 'PENDING' },
  });
  return toCamelRow(row);
}

/**
 * Simulated URA adapter. Walks PENDING -> QUEUED -> TRANSMITTED -> FISCALIZED and
 * issues the fiscal identifiers (FDN, verification code, fiscal QR). Already
 * fiscalised transactions are returned untouched - retries never duplicate a
 * fiscal document.
 */
export async function syncEfrisTransaction(client: pg.PoolClient, ctx: Ctx, id: number) {
  const lock = await client.query(
    `SELECT * FROM efris_transactions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, ctx.tenantId]
  );
  if (!lock.rows.length) throw notFound('EFRIS transaction not found');
  const t = lock.rows[0];
  if (t.status === 'FISCALIZED') return toCamelRow(t);
  if (t.status === 'CANCELLED') throw badRequest('EFRIS transaction is cancelled and cannot be synced');
  const steps = t.status === 'PENDING'
    ? ['QUEUED', 'TRANSMITTED']
    : t.status === 'QUEUED'
      ? ['TRANSMITTED']
      : [];
  for (const step of steps) {
    await client.query(`UPDATE efris_transactions SET status=$2, updated_at=now() WHERE id=$1`, [id, step]);
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [ctx.tenantId, id, step, JSON.stringify({ action: 'submitInvoice', attempt: Number(t.attempts) + 1 })]
    );
  }
  const fdn = `FDN${randCode(12)}`;
  const vrc = `VRC${randCode(12)}`;
  const qrRef = `QR${randCode(24)}`;
  const payload = { fdn, verificationCode: vrc, qrRef, submittedAt: new Date().toISOString() };
  const upd = await client.query(
    `UPDATE efris_transactions
        SET status='FISCALIZED', attempts=attempts+1, transmitted_at=now(), fiscalized_at=now(),
            last_error=NULL, updated_at=now()
      WHERE id=$1 RETURNING *`, [id]
  );
  await client.query(
    `INSERT INTO efris_documents
       (tenant_id, efris_transaction_id, erp_doc_no, fdn, verification_code, qr_ref,
        response_payload, transmitted_at, fiscalized_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
     ON CONFLICT (efris_transaction_id) DO UPDATE
       SET fdn=EXCLUDED.fdn, verification_code=EXCLUDED.verification_code,
           qr_ref=EXCLUDED.qr_ref, response_payload=EXCLUDED.response_payload,
           fiscalized_at=now()`,
    [ctx.tenantId, id, String(t.doc_ref_code), fdn, vrc, qrRef, JSON.stringify(payload)]
  );
  await client.query(
    `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload)
     VALUES ($1,$2,'FISCALIZED',$3::jsonb,$4::jsonb)`,
    [ctx.tenantId, id, JSON.stringify({ action: 'submitInvoice' }), JSON.stringify(payload)]
  );
  await finAudit(client, ctx, {
    action: 'EFRIS_FISCALIZED', module: 'efris', docType: String(t.doc_type), docId: id,
    docCode: String(t.doc_ref_code),
    previousValue: { status: String(t.status) }, newValue: { status: 'FISCALIZED', fdn, vrc, qrRef },
  });
  await emitEvent(client, ctx, {
    eventType: 'efris.fiscalized', entityType: 'EFRIS_TRANSACTION', entityId: id,
    entityCode: String(t.doc_ref_code), payload: { status: 'FISCALIZED', fdn, vrc, qrRef },
  });
  return toCamelRow(upd.rows[0]);
}
export async function cancelEfrisTransaction(client: pg.PoolClient, ctx: Ctx, id: number, reason: string) {
  const lock = await client.query(
    `SELECT * FROM efris_transactions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, ctx.tenantId]
  );
  if (!lock.rows.length) throw notFound('EFRIS transaction not found');
  const t = lock.rows[0];
  if (t.status === 'FISCALIZED') throw badRequest('A fiscalised EFRIS transaction cannot be cancelled');
  if (t.status === 'CANCELLED') return toCamelRow(t);
  await client.query(
    `UPDATE efris_transactions SET status='CANCELLED', last_error=$2, updated_at=now() WHERE id=$1`, [id, reason ?? 'Cancelled']
  );
  await client.query(
    `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, error)
     VALUES ($1,$2,'CANCELLED',$3::jsonb,$4)`,
    [ctx.tenantId, id, JSON.stringify({ action: 'cancelInvoice' }), reason ?? 'Cancelled']
  );
  await finAudit(client, ctx, {
    action: 'EFRIS_CANCELLED', module: 'efris', docType: String(t.doc_type), docId: id,
    docCode: String(t.doc_ref_code),
    previousValue: { status: String(t.status) }, newValue: { status: 'CANCELLED', reason },
  });
  return toCamelRow(await client.query(`SELECT * FROM efris_transactions WHERE id=$1`, [id]).then((r) => r.rows[0]));
}

export async function listEfrisDocuments(client: pg.PoolClient, ctx: Ctx, efrisTransactionId?: number) {
  const params: unknown[] = [ctx.tenantId];
  let where = 'WHERE d.tenant_id = $1';
  if (efrisTransactionId) { params.push(efrisTransactionId); where += ` AND d.efris_transaction_id = $${params.length}`; }
  const res = await client.query(
    `SELECT d.*, t.doc_ref_type, t.doc_ref_code, t.currency, t.gross_amount, t.tax_amount, t.status AS txn_status
     FROM efris_documents d
     JOIN efris_transactions t ON t.id = d.efris_transaction_id
     ${where} ORDER BY d.created_at DESC, d.id DESC`, params
  );
  return toCamelRows(res.rows);
}

export async function listEfrisSyncLogs(client: pg.PoolClient, ctx: Ctx, efrisTransactionId?: number) {
  const params: unknown[] = [ctx.tenantId];
  let where = 'WHERE l.tenant_id = $1';
  if (efrisTransactionId) { params.push(efrisTransactionId); where += ` AND l.efris_transaction_id = $${params.length}`; }
  const res = await client.query(
    `SELECT l.*, t.doc_ref_code FROM efris_sync_logs l
     JOIN efris_transactions t ON t.id = l.efris_transaction_id
     ${where} ORDER BY l.created_at DESC, l.id DESC`, params
  );
  return toCamelRows(res.rows);
}

// ---------- 5. Budget control: revisions, commitments, availability ----------
export async function listBudgetRevisions(client: pg.PoolClient, ctx: Ctx, budgetId?: number) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE br.tenant_id = $1 AND br.company_id = $2';
  if (budgetId) { params.push(budgetId); where += ` AND br.budget_id = $${params.length}`; }
  const res = await client.query(
    `SELECT br.*, b.budget_no, b.cost_centre_id
     FROM budget_revisions br JOIN budgets b ON b.id = br.budget_id
     ${where} ORDER BY br.created_at DESC, br.id DESC`, params
  );
  return toCamelRows(res.rows);
}

export async function createBudgetRevision(
  client: pg.PoolClient, ctx: Ctx, input: { budgetId: number; amount: number; reason?: string }
) {
  const budget = await client.query(
    `SELECT id FROM budgets WHERE id=$1 AND company_id=$2 AND tenant_id=$3`, [Number(input.budgetId), ctx.companyId, ctx.tenantId]
  );
  if (!budget.rows.length) throw notFound('Budget not found');
  const amount = n(input.amount);
  if (!(amount >= 0)) throw badRequest('Budget amount must be non-negative');
  const ins = await client.query(
    `INSERT INTO budget_revisions (company_id, tenant_id, budget_id, amount, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ctx.companyId, ctx.tenantId, Number(input.budgetId), amount, input.reason ?? null, ctx.userId ?? null]
  );
  await client.query(`UPDATE budgets SET amount=$2, updated_at=now() WHERE id=$1`, [Number(input.budgetId), amount]);
  await finAudit(client, ctx, {
    action: 'BUDGET_REVISED', module: 'budget', docType: 'BUDGET', docId: Number(input.budgetId),
    docCode: String(budget.rows[0].id), newValue: { amount, reason: input.reason ?? null },
  });
  return { revision: toCamelRow(ins.rows[0]), budgetId: Number(input.budgetId), amount };
}

export async function listBudgetCommitments(
  client: pg.PoolClient, ctx: Ctx, filters: { status?: string; docType?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE bc.tenant_id = $1 AND bc.company_id = $2';
  if (filters.status) { params.push(filters.status); where += ` AND bc.status = $${params.length}`; }
  if (filters.docType) { params.push(filters.docType); where += ` AND bc.doc_type = $${params.length}`; }
  const res = await client.query(
    `SELECT bc.*, a.code AS account_code, a.name AS account_name, b.budget_no
     FROM budget_commitments bc
     JOIN chart_of_accounts a ON a.id = bc.account_id
     JOIN budgets b ON b.id = bc.budget_id
     ${where} ORDER BY bc.created_at DESC, bc.id DESC`, params
  );
  return toCamelRows(res.rows);
}
export async function createBudgetCommitment(
  client: pg.PoolClient, ctx: Ctx,
  input: {
    budgetId: number; accountId?: number | null; accountCode?: string | null;
    docType: string; docRefType?: string | null; docRefId?: number | null; docRefCode?: string | null;
    amount: number;
  }
) {
  const accountId = input.accountId != null
    ? Number(input.accountId)
    : await getAccountId(client, ctx, String(input.accountCode ?? ''));
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('Commitment amount must be positive');
  const check = await client.query(
    `SELECT check_budget_available($1,$2,$3,$4,$5,$6,$7) AS result`,
    [ctx.companyId, ctx.tenantId, accountId, amount, input.docType,
     input.docRefType ?? null, input.docRefId ?? null]
  );
  const result = String(check.rows[0].result);
  if (result === 'BLOCK') {
    throw badRequest('Budget check BLOCKED: insufficient available budget for the account');
  }
  const existing = await client.query(
    `SELECT id FROM budget_commitments
     WHERE tenant_id=$1 AND doc_type=$2 AND doc_ref_type IS NOT DISTINCT FROM $3
       AND doc_ref_id IS NOT DISTINCT FROM $4 AND account_id=$5`,
    [ctx.tenantId, input.docType, input.docRefType ?? null, input.docRefId ?? null, accountId]
  );
  let row: Record<string, unknown>;
  if (existing.rows.length) {
    const upd = await client.query(
      `UPDATE budget_commitments
          SET budget_id=$2, amount=$3, status='COMMITTED', released_at=NULL
        WHERE id=$1 RETURNING *`,
      [existing.rows[0].id, Number(input.budgetId), amount]
    );
    row = upd.rows[0];
  } else {
    const ins = await client.query(
      `INSERT INTO budget_commitments
         (company_id, tenant_id, budget_id, account_id, doc_type, doc_ref_type, doc_ref_id,
          doc_ref_code, amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMMITTED',$10) RETURNING *`,
      [ctx.companyId, ctx.tenantId, Number(input.budgetId), accountId, input.docType,
       input.docRefType ?? null, input.docRefId ?? null, input.docRefCode ?? null,
       amount, ctx.userId ?? null]
    );
    row = ins.rows[0];
  }
  await finAudit(client, ctx, {
    action: 'BUDGET_COMMITTED', module: 'budget', docType: input.docType,
    docId: input.docRefId ?? null, docCode: input.docRefCode ?? null,
    newValue: { budgetId: Number(input.budgetId), accountId, amount, budgetCheck: result },
  });
  return { commitment: toCamelRow(row), budgetCheck: result, warning: result === 'WARNING' };
}

export async function releaseBudgetCommitment(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `UPDATE budget_commitments SET status='RELEASED', released_at=now()
     WHERE id=$1 AND tenant_id=$2 RETURNING *`, [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Budget commitment not found');
  await finAudit(client, ctx, {
    action: 'BUDGET_RELEASED', module: 'budget', docType: 'BUDGET_COMMITMENT', docId: id,
    newValue: { status: 'RELEASED' },
  });
  return toCamelRow(res.rows[0]);
}

export async function checkBudget(
  client: pg.PoolClient, ctx: Ctx,
  input: { accountId?: number | null; accountCode?: string | null; amount: number; docType: string; docRefType?: string | null; docRefId?: number | null }
) {
  const accountId = input.accountId != null
    ? Number(input.accountId)
    : await getAccountId(client, ctx, String(input.accountCode ?? ''));
  const pos = await budgetPosition(client, ctx, accountId);
  const amount = n(input.amount);
  let result = pos.result;
  if (pos.result !== 'NONE' && pos.available + 0.005 < amount) result = 'BLOCK';
  else if (pos.result !== 'NONE') result = 'ALLOW';
  return { ...pos, result, requested: amount };
}

// ---------- 6. Manufacturing costing: allocation rules, production cost, WIP ----------
export async function listAllocationRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT ar.*, cc.code AS cost_centre_code, cc.name AS cost_centre_name
     FROM allocation_rules ar
     LEFT JOIN cost_centres cc ON cc.id = ar.source_cost_centre_id
     WHERE ar.tenant_id=$1 AND ar.company_id=$2 ORDER BY ar.code`, [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createAllocationRule(
  client: pg.PoolClient, ctx: Ctx,
  input: { code: string; name: string; sourceCostCentreId?: number | null; driver?: string; rate?: number }
) {
  const res = await client.query(
    `INSERT INTO allocation_rules
       (company_id, tenant_id, code, name, source_cost_centre_id, driver, rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.code, input.name, input.sourceCostCentreId ?? null,
     input.driver ?? 'MACHINE_HOURS', n(input.rate)]
  );
  return toCamelRow(res.rows[0]);
}
export async function captureProductionCost(
  client: pg.PoolClient, ctx: Ctx,
  input: {
    workOrderId?: number | null; productId?: number | null; costDate?: string;
    quantity: number; expectedCost: number; expectedByType?: Record<string, number>;
    components: Array<{
      componentType: string; costCentreId?: number | null; amount: number;
      quantity?: number | null; rate?: number | null; notes?: string | null;
    }>;
  }
) {
  if (!input.components || !input.components.length) {
    throw badRequest('Production cost requires at least one cost component');
  }
  const quantity = n(input.quantity);
  if (!(quantity > 0)) throw badRequest('Production quantity must be positive');
  const expected = n(input.expectedCost);
  const actual = round2(input.components.reduce((s, c) => s + n(c.amount), 0));
  const variance = round2(actual - expected);
  const costDate = isoDate(input.costDate);
  const periodRes = await client.query(
    `SELECT id FROM financial_periods
     WHERE company_id=$1 AND start_date<=$2::date AND end_date>=$2::date ORDER BY start_date LIMIT 1`,
    [ctx.companyId, costDate]
  );
  const periodId = periodRes.rows.length ? Number(periodRes.rows[0].id) : null;
  const ins = await client.query(
    `INSERT INTO production_costs
       (company_id, tenant_id, work_order_id, product_id, period_id, cost_date, quantity,
        expected_cost, actual_cost, variance, status, calculated_by, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CALCULATED',$11,now()) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.workOrderId ?? null, input.productId ?? null, periodId,
     costDate, quantity, expected, actual, variance, ctx.userId ?? null]
  );
  const costId = Number(ins.rows[0].id);
  const byType = new Map<string, number>();
  for (const c of input.components) {
    await client.query(
      `INSERT INTO production_cost_components
         (production_cost_id, component_type, cost_centre_id, amount, quantity, rate, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [costId, String(c.componentType).toUpperCase(), c.costCentreId ?? null, n(c.amount),
       c.quantity ?? null, c.rate ?? null, c.notes ?? null]
    );
    byType.set(String(c.componentType).toUpperCase(), n(byType.get(String(c.componentType).toUpperCase())) + n(c.amount));
  }
  await client.query(
    `INSERT INTO cost_variances (production_cost_id, variance_type, expected, actual, variance)
     VALUES ($1,'TOTAL',$2,$3,$4)`, [costId, expected, actual, variance]
  );
  const expectedByType = input.expectedByType ?? {};
  for (const [type, actualAmount] of byType.entries()) {
    const exp = n(expectedByType[type]);
    if (exp === 0) continue;
    await client.query(
      `INSERT INTO cost_variances (production_cost_id, variance_type, expected, actual, variance)
       VALUES ($1,$2,$3,$4,$5)`, [costId, type, exp, actualAmount, round2(actualAmount - exp)]
    );
  }
  await finAudit(client, ctx, {
    action: 'PRODUCTION_COST_CALCULATED', module: 'finance', docType: 'PRODUCTION_COST', docId: costId,
    docCode: String(costId), newValue: { expected, actual, variance, quantity },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.production_cost.calculated', entityType: 'PRODUCTION_COST', entityId: costId,
    entityCode: String(costId), payload: { expected, actual, variance, status: 'CALCULATED' },
  });
  return {
    productionCost: toCamelRow(ins.rows[0]),
    costPerUnit: round2(actual / quantity),
    components: input.components,
  };
}

export async function listProductionCosts(
  client: pg.PoolClient, ctx: Ctx,
  filters: { from?: string; to?: string; status?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE pc.tenant_id = $1 AND pc.company_id = $2';
  if (filters.status) { params.push(filters.status); where += ` AND pc.status = $${params.length}`; }
  if (filters.from) { params.push(filters.from); where += ` AND pc.cost_date >= $${params.length}::date`; }
  if (filters.to) { params.push(filters.to); where += ` AND pc.cost_date <= $${params.length}::date`; }
  const res = await client.query(
    `SELECT pc.*, p.name AS product_name, p.sku AS product_sku,
            p2.code AS period_code
     FROM production_costs pc
     LEFT JOIN products p ON p.id = pc.product_id
     LEFT JOIN financial_periods p2 ON p2.id = pc.period_id
     ${where} ORDER BY pc.cost_date DESC, pc.id DESC`, params
  );
  return toCamelRows(res.rows);
}
export async function getProductionCost(client: pg.PoolClient, ctx: Ctx, id: number) {
  const header = await client.query(
    `SELECT pc.*, p.name AS product_name, p.sku AS product_sku, p2.code AS period_code
     FROM production_costs pc
     LEFT JOIN products p ON p.id = pc.product_id
     LEFT JOIN financial_periods p2 ON p2.id = pc.period_id
     WHERE pc.id=$1 AND pc.tenant_id=$2`, [id, ctx.tenantId]
  );
  if (!header.rows.length) throw notFound('Production cost not found');
  const components = await client.query(
    `SELECT pc2.*, cc.code AS cost_centre_code, cc.name AS cost_centre_name
     FROM production_cost_components pc2
     LEFT JOIN cost_centres cc ON cc.id = pc2.cost_centre_id
     WHERE pc2.production_cost_id=$1 ORDER BY pc2.id`, [id]
  );
  const variances = await client.query(
    `SELECT * FROM cost_variances WHERE production_cost_id=$1 ORDER BY id`, [id]
  );
  return {
    productionCost: toCamelRow(header.rows[0]),
    components: toCamelRows(components.rows),
    variances: toCamelRows(variances.rows),
  };
}

/** Post the finished-goods vs WIP journal via the configurable FG_WIP posting rule. */
export async function postProductionCost(client: pg.PoolClient, ctx: Ctx, id: number) {
  const lock = await client.query(
    `SELECT * FROM production_costs WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [id, ctx.tenantId]
  );
  if (!lock.rows.length) throw notFound('Production cost not found');
  const pc = lock.rows[0];
  if (pc.status === 'POSTED') {
    return { productionCost: toCamelRow(pc), journalId: pc.journal_id ? Number(pc.journal_id) : null };
  }
  if (pc.status !== 'CALCULATED') {
    throw badRequest(`Production cost is ${pc.status}; only calculated costs can be posted`);
  }
  const out = await applyPostingRule(client, ctx, {
    event: 'PRODUCTION_COMPLETE', code: 'FG_WIP', amount: n(pc.actual_cost),
    entryDate: isoDate(pc.cost_date),
    description: `Production cost ${pc.id} - finished goods vs WIP`,
    refType: 'production_costs', refId: Number(pc.id), refCode: String(pc.id),
  });
  const upd = await client.query(
    `UPDATE production_costs SET status='POSTED', journal_id=$2 WHERE id=$1 RETURNING *`, [id, out.entryId]
  );
  await finAudit(client, ctx, {
    action: 'PRODUCTION_COST_POSTED', module: 'finance', docType: 'PRODUCTION_COST', docId: id,
    docCode: String(id), previousValue: { status: String(pc.status) },
    newValue: { status: 'POSTED', journalId: out.entryId },
  });
  return { productionCost: toCamelRow(upd.rows[0]), journalId: out.entryId };
}

export async function listWipLedger(client: pg.PoolClient, ctx: Ctx, workOrderId?: number) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE tenant_id = $1 AND company_id = $2';
  if (workOrderId) { params.push(workOrderId); where += ` AND work_order_id = $${params.length}`; }
  const res = await client.query(`SELECT * FROM wip_ledger ${where} ORDER BY txn_date DESC, id DESC`, params);
  return toCamelRows(res.rows);
}

export async function recordWipMovement(
  client: pg.PoolClient, ctx: Ctx,
  input: {
    workOrderId?: number | null; txnType: string; txnDate?: string; amount: number;
    accountId?: number | null; journalId?: number | null; notes?: string | null;
  }
) {
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('WIP movement amount must be positive');
  const txnType = String(input.txnType ?? '').toUpperCase();
  const allowed = ['MATERIAL_ISSUE', 'LABOUR', 'MACHINE', 'OVERHEAD', 'COMPLETE', 'SCRAP', 'ADJUSTMENT'];
  if (!allowed.includes(txnType)) throw badRequest(`Unsupported WIP transaction type ${txnType}`);
  const ins = await client.query(
    `INSERT INTO wip_ledger
       (company_id, tenant_id, work_order_id, txn_type, txn_date, amount, account_id, journal_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.companyId, ctx.tenantId, input.workOrderId ?? null, txnType, isoDate(input.txnDate),
     amount, input.accountId ?? null, input.journalId ?? null, input.notes ?? null, ctx.userId ?? null]
  );
  await finAudit(client, ctx, {
    action: 'WIP_MOVEMENT', module: 'finance', docType: 'WIP_LEDGER', docId: Number(ins.rows[0].id),
    docCode: String(input.workOrderId ?? ''), newValue: { txnType, amount },
  });
  return toCamelRow(ins.rows[0]);
}
// ---------- 7. Intercompany accounting ----------
async function accountIdForCompany(
  client: pg.PoolClient, tenantId: number | null | undefined, companyId: number, code: string
): Promise<number> {
  const res = await client.query(
    `SELECT id FROM chart_of_accounts
     WHERE company_id=$1 AND tenant_id=$2 AND code=$3 AND is_active=true`,
    [companyId, tenantId ?? 0, code]
  );
  if (!res.rows.length) throw badRequest(`Chart of accounts code ${code} not found in company ${companyId}`);
  return Number(res.rows[0].id);
}

async function openPeriodForCompany(client: pg.PoolClient, companyId: number, entryDate: string): Promise<number> {
  const res = await client.query(
    `SELECT id FROM financial_periods
     WHERE company_id=$1 AND start_date<=$2::date AND end_date>=$2::date
       AND status IN ('OPEN','SOFT_CLOSE') ORDER BY start_date LIMIT 1`,
    [companyId, entryDate]
  );
  if (!res.rows.length) throw badRequest(`No open financial period covers ${entryDate} for company ${companyId}`);
  return Number(res.rows[0].id);
}

export async function listCompanies(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name, legal_name, currency, status FROM companies
     WHERE tenant_id=$1 ORDER BY code`, [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

/**
 * Post a balanced intercompany transfer: source company debits Due From
 * Intercompany and credits its bank; destination company debits its bank and
 * credits Due To Intercompany. Both journals post through post_journal, so the
 * double-entry invariant holds in every company ledger.
 */
export async function createIntercompanyTransfer(
  client: pg.PoolClient, ctx: Ctx,
  input: {
    fromCompanyId: number; toCompanyId: number; txnDate?: string;
    currency?: string; exchangeRate?: number; amount: number; description?: string;
    fromAccountCode?: string; toAccountCode?: string;
    dueFromAccountCode?: string; dueToAccountCode?: string;
  }
) {
  const fromCompanyId = Number(input.fromCompanyId);
  const toCompanyId = Number(input.toCompanyId);
  if (!fromCompanyId || !toCompanyId) throw badRequest('Source and destination companies are required');
  if (fromCompanyId === toCompanyId) {
    throw badRequest('Intercompany transfer requires two different companies');
  }
  const companies = await client.query(
    `SELECT id, code, name, currency FROM companies
     WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [ctx.tenantId, [fromCompanyId, toCompanyId]]
  );
  if (companies.rows.length !== 2) throw badRequest('Both companies must belong to the tenant');
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('Intercompany amount must be positive');
  const txnDate = isoDate(input.txnDate);
  const currency = input.currency ?? 'UGX';
  const rate = n(input.exchangeRate) || 1;
  const fromPeriodId = await openPeriodForCompany(client, fromCompanyId, txnDate);
  const toPeriodId = await openPeriodForCompany(client, toCompanyId, txnDate);
  const dueFromCode = input.dueFromAccountCode ?? '1405';
  const dueToCode = input.dueToAccountCode ?? '2105';
  const fromBankId = await accountIdForCompany(client, ctx.tenantId, fromCompanyId, input.fromAccountCode ?? '1100');
  const toBankId = await accountIdForCompany(client, ctx.tenantId, toCompanyId, input.toAccountCode ?? '1100');
  const fromDueFromId = await accountIdForCompany(client, ctx.tenantId, fromCompanyId, dueFromCode);
  const toDueToId = await accountIdForCompany(client, ctx.tenantId, toCompanyId, dueToCode);
  const docNo = await nextDocNo(client, ctx, 'ICT');
  const desc = input.description ?? `Intercompany transfer ${docNo}`;
  const linesFrom = JSON.stringify([
    { account_id: fromDueFromId, debit: amount, credit: 0, cost_centre_id: null, profit_centre_id: null, description: `Due from company ${toCompanyId}` },
    { account_id: fromBankId, debit: 0, credit: amount, cost_centre_id: null, profit_centre_id: null, description: `Bank (to ${toCompanyId})` },
  ]);
  const fromEntry = await client.query(
    `SELECT post_journal($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) AS entry_id`,
    [fromCompanyId, ctx.tenantId, null, txnDate, 'INTERCOMPANY', desc, linesFrom,
     'intercompany_transactions', null, docNo, ctx.userId ?? null, fromPeriodId, currency, rate]
  );
  const linesTo = JSON.stringify([
    { account_id: toBankId, debit: amount, credit: 0, cost_centre_id: null, profit_centre_id: null, description: `Bank (from company ${fromCompanyId})` },
    { account_id: toDueToId, debit: 0, credit: amount, cost_centre_id: null, profit_centre_id: null, description: `Due to company ${fromCompanyId}` },
  ]);
  const toEntry = await client.query(
    `SELECT post_journal($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) AS entry_id`,
    [toCompanyId, ctx.tenantId, null, txnDate, 'INTERCOMPANY', desc, linesTo,
     'intercompany_transactions', null, docNo, ctx.userId ?? null, toPeriodId, currency, rate]
  );
  const ins = await client.query(
    `INSERT INTO intercompany_transactions
       (tenant_id, from_company_id, to_company_id, doc_no, txn_date, currency, exchange_rate,
        amount, description, status, from_journal_id, to_journal_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'POSTED',$10,$11,$12) RETURNING *`,
    [ctx.tenantId, fromCompanyId, toCompanyId, docNo, txnDate, currency, rate, amount,
     desc, Number(fromEntry.rows[0].entry_id), Number(toEntry.rows[0].entry_id), ctx.userId ?? null]
  );
  await finAudit(client, ctx, {
    action: 'INTERCOMPANY_POSTED', module: 'finance', docType: 'INTERCOMPANY', docId: Number(ins.rows[0].id),
    docCode: docNo,
    newValue: { fromCompanyId, toCompanyId, amount, currency, rate, fromJournalId: Number(fromEntry.rows[0].entry_id), toJournalId: Number(toEntry.rows[0].entry_id) },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.intercompany.posted', entityType: 'INTERCOMPANY_TRANSACTION',
    entityId: Number(ins.rows[0].id), entityCode: docNo,
    payload: { fromCompanyId, toCompanyId, amount, status: 'POSTED' },
  });
  return toCamelRow(ins.rows[0]);
}

export async function listIntercompanyTransactions(
  client: pg.PoolClient, ctx: Ctx, filters: { from?: string; to?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId];
  let where = 'WHERE it.tenant_id = $1';
  if (filters.from) { params.push(filters.from); where += ` AND it.txn_date >= $${params.length}::date`; }
  if (filters.to) { params.push(filters.to); where += ` AND it.txn_date <= $${params.length}::date`; }
  const res = await client.query(
    `SELECT it.*, fc.code AS from_company_code, fc.name AS from_company_name,
            tc.code AS to_company_code, tc.name AS to_company_name
     FROM intercompany_transactions it
     JOIN companies fc ON fc.id = it.from_company_id
     JOIN companies tc ON tc.id = it.to_company_id
     ${where} ORDER BY it.txn_date DESC, it.id DESC`, params
  );
  return toCamelRows(res.rows);
}
// ---------- 8. Financial consolidation ----------
export async function runConsolidation(
  client: pg.PoolClient, ctx: Ctx,
  input: { periodStart: string; periodEnd: string; targetCurrency?: string }
) {
  const start = isoDate(input.periodStart);
  const end = isoDate(input.periodEnd);
  if (start > end) throw badRequest('Consolidation period start must be before end');
  const target = String(input.targetCurrency ?? 'UGX').toUpperCase();
  const companies = await client.query(
    `SELECT id, code, name, currency FROM companies WHERE tenant_id=$1 ORDER BY code`, [ctx.tenantId]
  );
  const perCompany: unknown[] = [];
  const consolidated = new Map<string, { code: string; name: string; accountType: string; amount: number; companies: unknown[] }>();
  for (const c of companies.rows) {
    const srcCur = String(c.currency ?? 'UGX');
    let rate = 1;
    if (srcCur !== target) {
      const fx = await client.query(
        `SELECT rate FROM exchange_rates WHERE currency_code=$1 AND rate_date<=$2::date
         ORDER BY rate_date DESC LIMIT 1`, [srcCur, end]
      );
      if (fx.rows.length) rate = Number(fx.rows[0].rate);
    }
    const tb = await client.query(
      `SELECT a.code, a.name, a.account_type,
              SUM(jl.debit)::numeric AS debit, SUM(jl.credit)::numeric AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN chart_of_accounts a ON a.id = jl.account_id
       WHERE je.tenant_id=$1 AND je.company_id=$2 AND je.status='POSTED'
         AND je.entry_date BETWEEN $3::date AND $4::date
       GROUP BY a.id ORDER BY a.code`,
      [ctx.tenantId, Number(c.id), start, end]
    );
    let debit = 0; let credit = 0;
    for (const r of tb.rows) {
      debit += Number(r.debit) * rate;
      credit += Number(r.credit) * rate;
      const bal = round2((Number(r.debit) - Number(r.credit)) * rate);
      const key = String(r.code);
      const cur = consolidated.get(key) ?? {
        code: key, name: String(r.name), accountType: String(r.account_type),
        amount: 0, companies: [] as unknown[],
      };
      cur.amount = round2(cur.amount + bal);
      cur.companies.push({ companyId: Number(c.id), code: String(c.code), balance: bal });
      consolidated.set(key, cur);
    }
    perCompany.push({
      companyId: Number(c.id), code: String(c.code), name: String(c.name),
      currency: srcCur, rate,
      totals: { debit: round2(debit), credit: round2(credit) },
      balanced: Math.round(debit * 100) === Math.round(credit * 100),
    });
  }
  const eliminations: Array<{ accountCode: string; debit: number; credit: number; description: string }> = [];
  const dueFrom = consolidated.get('1405');
  const dueTo = consolidated.get('2105');
  if (dueFrom && dueTo) {
    const off = Math.min(Math.abs(dueFrom.amount), Math.abs(dueTo.amount));
    if (off > 0) {
      dueFrom.amount = round2(dueFrom.amount - off);
      dueTo.amount = round2(dueTo.amount + off);
      eliminations.push({ accountCode: '1405', debit: 0, credit: off, description: 'Eliminate intercompany due-from balances' });
      eliminations.push({ accountCode: '2105', debit: off, credit: 0, description: 'Eliminate intercompany due-to balances' });
    }
  }
  const consolidatedRows = [...consolidated.values()].sort((a, b) => a.code.localeCompare(b.code));
  const consDebit = round2(consolidatedRows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0));
  const consCredit = round2(-consolidatedRows.reduce((s, r) => s + (r.amount < 0 ? r.amount : 0), 0));
  const results = {
    period: { start, end },
    targetCurrency: target,
    companies: perCompany,
    consolidated: consolidatedRows,
    totals: {
      debit: consDebit, credit: consCredit,
      balanced: Math.round(consDebit * 100) === Math.round(consCredit * 100),
    },
    eliminations,
  };
  const ins = await client.query(
    `INSERT INTO consolidation_runs
       (tenant_id, period_start, period_end, target_currency, status, results, created_by, completed_at)
     VALUES ($1,$2,$3,$4,'COMPLETED',$5::jsonb,$6,now()) RETURNING *`,
    [ctx.tenantId, start, end, target, JSON.stringify(results), ctx.userId ?? null]
  );
  const runId = Number(ins.rows[0].id);
  for (const e of eliminations) {
    await client.query(
      `INSERT INTO elimination_entries (consolidation_run_id, account_code, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [runId, e.accountCode, e.debit, e.credit, e.description]
    );
  }
  await finAudit(client, ctx, {
    action: 'CONSOLIDATION_RUN', module: 'finance', docType: 'CONSOLIDATION_RUN', docId: runId,
    docCode: String(runId),
    newValue: { period: { start, end }, targetCurrency: target, companies: perCompany.length },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.consolidation.completed', entityType: 'CONSOLIDATION_RUN',
    entityId: runId, entityCode: String(runId),
    payload: { status: 'COMPLETED', start, end, targetCurrency: target },
  });
  return { ...toCamelRow(ins.rows[0]), results };
}

export async function listConsolidationRuns(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM consolidation_runs WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

export async function getConsolidationRun(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM consolidation_runs WHERE id=$1 AND tenant_id=$2`, [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Consolidation run not found');
  const eliminations = await client.query(
    `SELECT * FROM elimination_entries WHERE consolidation_run_id=$1 ORDER BY id`, [id]
  );
  return { ...toCamelRow(res.rows[0]), eliminations: toCamelRows(eliminations.rows) };
}
// ---------- 9. Period close cockpit ----------
export async function listCloseTasks(client: pg.PoolClient, ctx: Ctx, periodId?: number) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE t.tenant_id = $1 AND t.company_id = $2';
  if (periodId) { params.push(periodId); where += ` AND t.period_id = $${params.length}`; }
  const res = await client.query(
    `SELECT t.*, p.code AS period_code, p.status AS period_status,
            d.task_name AS dependency_name
     FROM financial_close_tasks t
     JOIN financial_periods p ON p.id = t.period_id
     LEFT JOIN financial_close_tasks d ON d.company_id = t.company_id
        AND d.period_id = t.period_id AND d.task_key = t.dependency_task_key
     ${where} ORDER BY t.id`, params
  );
  return toCamelRows(res.rows);
}

export async function updateCloseTask(
  client: pg.PoolClient, ctx: Ctx, id: number,
  input: { status?: string; notes?: string }
) {
  const lock = await client.query(
    `SELECT * FROM financial_close_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [id, ctx.tenantId]
  );
  if (!lock.rows.length) throw notFound('Close task not found');
  const t = lock.rows[0];
  const nextStatus = String(input.status ?? t.status).toUpperCase();
  const allowed = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'WAIVED'];
  if (!allowed.includes(nextStatus)) throw badRequest(`Unsupported close task status ${nextStatus}`);
  if (nextStatus === 'COMPLETED' && t.dependency_task_key) {
    const dep = await client.query(
      `SELECT status FROM financial_close_tasks
       WHERE company_id=$1 AND period_id=$2 AND task_key=$3`,
      [Number(t.company_id), Number(t.period_id), String(t.dependency_task_key)]
    );
    if (dep.rows.length && !['COMPLETED', 'WAIVED'].includes(String(dep.rows[0].status))) {
      throw badRequest(`Dependency task ${t.dependency_task_key} (${dep.rows[0].status}) must be completed first`);
    }
  }
  const upd = await client.query(
    `UPDATE financial_close_tasks
        SET status=$2,
            notes=COALESCE($3, notes),
            approved_by=CASE WHEN $2='COMPLETED' THEN $4 ELSE approved_by END,
            approved_at=CASE WHEN $2='COMPLETED' THEN now() ELSE approved_at END,
            updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, nextStatus, input.notes ?? null, ctx.userId ?? null]
  );
  await finAudit(client, ctx, {
    action: 'CLOSE_TASK_' + nextStatus, module: 'finance', docType: 'CLOSE_TASK', docId: id,
    docCode: String(t.task_key), previousValue: { status: String(t.status) },
    newValue: { status: nextStatus, notes: input.notes ?? null },
  });
  return toCamelRow(upd.rows[0]);
}

export async function runPeriodClose(client: pg.PoolClient, ctx: Ctx, periodId: number) {
  const period = await client.query(
    `SELECT * FROM financial_periods WHERE id=$1 AND company_id=$2 AND tenant_id=$3 FOR UPDATE`,
    [periodId, ctx.companyId, ctx.tenantId]
  );
  if (!period.rows.length) throw notFound('Financial period not found');
  const p = period.rows[0];
  if (String(p.status) === 'CLOSED') {
    return { period: toCamelRow(p), status: 'CLOSED', alreadyClosed: true };
  }
  const pending = await client.query(
    `SELECT task_key, task_name FROM financial_close_tasks
     WHERE company_id=$1 AND period_id=$2 AND status NOT IN ('COMPLETED','WAIVED')
     ORDER BY id`, [ctx.companyId, periodId]
  );
  if (pending.rows.length) {
    const names = pending.rows.map((r: { task_name: string }) => String(r.task_name)).join(', ');
    throw badRequest(`Period close blocked: incomplete close tasks - ${names}`);
  }
  const upd = await client.query(
    `UPDATE financial_periods SET status='CLOSED', updated_at=now() WHERE id=$1 RETURNING *`, [periodId]
  );
  await finAudit(client, ctx, {
    action: 'PERIOD_CLOSED', module: 'finance', docType: 'FINANCIAL_PERIOD', docId: periodId,
    docCode: String(p.code), previousValue: { status: String(p.status) }, newValue: { status: 'CLOSED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'finance.period.closed', entityType: 'FINANCIAL_PERIOD', entityId: periodId,
    entityCode: String(p.code), payload: { status: 'CLOSED' },
  });
  const next = await client.query(
    `SELECT id FROM financial_periods
     WHERE company_id=$1 AND tenant_id=$2 AND status='OPEN' AND start_date > $3::date
     ORDER BY start_date LIMIT 1`, [ctx.companyId, ctx.tenantId, String(p.end_date)]
  );
  let nextPeriodSeeded: number | null = null;
  if (next.rows.length) {
    await client.query(`SELECT seed_close_tasks($1)`, [Number(next.rows[0].id)]);
    nextPeriodSeeded = Number(next.rows[0].id);
  }
  return { period: toCamelRow(upd.rows[0]), status: 'CLOSED', nextPeriodSeeded };
}

// ---------- 10. Financial audit + CFO summary ----------
export async function listFinancialAudit(
  client: pg.PoolClient, ctx: Ctx,
  filters: { limit?: number; module?: string; docType?: string } = {}
) {
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 100), 500));
  const params: unknown[] = [ctx.tenantId];
  let where = 'WHERE fal.tenant_id = $1';
  if (filters.module) { params.push(filters.module); where += ` AND fal.module = $${params.length}`; }
  if (filters.docType) { params.push(filters.docType); where += ` AND fal.doc_type = $${params.length}`; }
  params.push(limit);
  const res = await client.query(
    `SELECT fal.*, u.name AS user_name, u.email AS user_email
     FROM financial_audit_logs fal
     LEFT JOIN users u ON u.id = fal.user_id
     ${where} ORDER BY fal.created_at DESC, fal.id DESC LIMIT $${params.length}`, params
  );
  return toCamelRows(res.rows);
}

export async function financeAdvancedSummary(client: pg.PoolClient, ctx: Ctx) {
  const pendingJournals = await client.query(
    `SELECT COUNT(*)::int AS c FROM journal_entries
     WHERE tenant_id=$1 AND company_id=$2 AND status IN ('DRAFT','SUBMITTED','PENDING_APPROVAL')`,
    [ctx.tenantId, ctx.companyId]
  );
  const pendingEfris = await client.query(
    `SELECT COUNT(*)::int AS c FROM efris_transactions
     WHERE tenant_id=$1 AND company_id=$2 AND status IN ('PENDING','QUEUED','TRANSMITTED','RETRYING')`,
    [ctx.tenantId, ctx.companyId]
  );
  const committedBudget = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS v FROM budget_commitments
     WHERE tenant_id=$1 AND company_id=$2 AND status='COMMITTED'`, [ctx.tenantId, ctx.companyId]
  );
  const productionVariance = await client.query(
    `SELECT COALESCE(SUM(variance),0)::numeric AS v FROM production_costs
     WHERE tenant_id=$1 AND company_id=$2 AND status IN ('CALCULATED','POSTED')`,
    [ctx.tenantId, ctx.companyId]
  );
  const openCloseTasks = await client.query(
    `SELECT COUNT(*)::int AS c FROM financial_close_tasks
     WHERE tenant_id=$1 AND company_id=$2 AND status IN ('PENDING','IN_PROGRESS','BLOCKED')`,
    [ctx.tenantId, ctx.companyId]
  );
  const integrity = await client.query(
    `SELECT COUNT(*)::int AS c FROM journal_entries je
     WHERE je.tenant_id=$1 AND je.company_id=$2 AND je.status='POSTED'
       AND round(journal_balance(je.id),2) <> 0`, [ctx.tenantId, ctx.companyId]
  );
  const taxDue = await client.query(
    `SELECT COALESCE(SUM(tax_amount),0)::numeric AS v FROM tax_transactions
     WHERE tenant_id=$1 AND company_id=$2 AND status='POSTED'`, [ctx.tenantId, ctx.companyId]
  );
  const fiscalized = await client.query(
    `SELECT COUNT(*)::int AS c FROM efris_transactions
     WHERE tenant_id=$1 AND company_id=$2 AND status='FISCALIZED'`, [ctx.tenantId, ctx.companyId]
  );
  return {
    pendingJournals: Number(pendingJournals.rows[0].c),
    pendingEfris: Number(pendingEfris.rows[0].c),
    fiscalizedEfris: Number(fiscalized.rows[0].c),
    committedBudget: Number(committedBudget.rows[0].v),
    productionVariance: Number(productionVariance.rows[0].v),
    openCloseTasks: Number(openCloseTasks.rows[0].c),
    taxDue: Number(taxDue.rows[0].v),
    integrityIssues: Number(integrity.rows[0].c),
    trialBalanceOk: Number(integrity.rows[0].c) === 0,
  };
}