/**
 * Finance approval inbox.
 *
 * Reads the workflow approval queue - already scoped to the caller's role,
 * delegation and segregation-of-duties rules - and enriches the finance
 * documents it contains, so an approver can see the financial impact, the
 * budget position and the approvals that already happened without opening the
 * record first.
 *
 * This module never decides anything. Decisions stay on
 * POST /api/approvals/:taskId/decide so RBAC, ABAC and segregation of duties
 * are enforced in exactly one place.
 */
import pg from 'pg';
import { Ctx } from '../db.js';
import { ENTITIES } from './entities.js';
import { budgetPosition, type BudgetPosition } from './finance.js';
import { getApprovalsQueue } from './workflow.js';

export type FinApprovalGroup = 'PAYABLES' | 'RECEIVABLES' | 'SPEND' | 'CASH' | 'PAYROLL' | 'ASSETS';

export type LedgerEffect = 'POSTS_ENTRY' | 'RELEASES_PAYMENT' | 'RECORD_ONLY';

type Party =
  | { kind: 'table'; table: string; fk: string; nameColumn: string }
  | { kind: 'column'; column: string };

interface FinApprovalDoc {
  group: FinApprovalGroup;
  label: string;
  table: string;
  codeColumn: string;
  amountColumn: string;
  dateColumn: string;
  dateLabel: string;
  currencyColumn?: string;
  glPostedColumn?: string;
  accountColumn?: string;
  budgetColumn?: string;
  party?: Party;
}

/**
 * Every entry is a real finance document driven by a workflow. Column names are
 * hard-coded on purpose: they are never taken from a request.
 */
const DOCS: Record<string, FinApprovalDoc> = {
  'sales.invoices': {
    group: 'RECEIVABLES', label: 'Customer invoice', table: 'customer_invoices',
    codeColumn: 'invoice_no', amountColumn: 'total', dateColumn: 'invoice_date',
    dateLabel: 'Invoice date', currencyColumn: 'currency', glPostedColumn: 'gl_posted',
    party: { kind: 'table', table: 'customers', fk: 'customer_id', nameColumn: 'name' },
  },
  'sales.credit_notes': {
    group: 'RECEIVABLES', label: 'Credit note', table: 'credit_notes',
    codeColumn: 'credit_no', amountColumn: 'amount', dateColumn: 'credit_date',
    dateLabel: 'Credit date', glPostedColumn: 'gl_posted',
    party: { kind: 'table', table: 'customers', fk: 'customer_id', nameColumn: 'name' },
  },
  'sales.debit_notes': {
    group: 'RECEIVABLES', label: 'Debit note', table: 'debit_notes',
    codeColumn: 'debit_no', amountColumn: 'amount', dateColumn: 'debit_date',
    dateLabel: 'Debit date', glPostedColumn: 'gl_posted',
    party: { kind: 'table', table: 'customers', fk: 'customer_id', nameColumn: 'name' },
  },
  'procurement.supplier_invoices': {
    group: 'PAYABLES', label: 'Supplier invoice', table: 'supplier_invoices',
    codeColumn: 'supplier_invoice_no', amountColumn: 'total', dateColumn: 'invoice_date',
    dateLabel: 'Invoice date', currencyColumn: 'currency', glPostedColumn: 'gl_posted',
    party: { kind: 'table', table: 'suppliers', fk: 'supplier_id', nameColumn: 'name' },
  },
  'procurement.payments': {
    group: 'PAYABLES', label: 'Payment voucher', table: 'supplier_payments',
    codeColumn: 'payment_no', amountColumn: 'amount', dateColumn: 'payment_date',
    dateLabel: 'Payment date', glPostedColumn: 'gl_posted',
    party: { kind: 'table', table: 'suppliers', fk: 'supplier_id', nameColumn: 'name' },
  },
  'ops.expenses': {
    group: 'SPEND', label: 'Expense', table: 'expense_transactions',
    codeColumn: 'exp_no', amountColumn: 'amount', dateColumn: 'exp_date',
    dateLabel: 'Expense date', currencyColumn: 'currency', glPostedColumn: 'gl_posted',
    accountColumn: 'account_id', budgetColumn: 'budget_id',
    party: { kind: 'column', column: 'payee' },
  },
  'ops.claims': {
    group: 'SPEND', label: 'Expense claim', table: 'employee_expense_claims',
    codeColumn: 'claim_no', amountColumn: 'amount', dateColumn: 'expense_date',
    dateLabel: 'Expense date', glPostedColumn: 'gl_posted',
    party: {
      kind: 'table', table: 'employees', fk: 'employee_id',
      nameColumn: "NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')",
    },
  },
  'ops.replenishments': {
    group: 'CASH', label: 'Petty cash replenishment', table: 'petty_cash_replenishments',
    codeColumn: 'rep_no', amountColumn: 'amount', dateColumn: 'rep_date',
    dateLabel: 'Request date', glPostedColumn: 'gl_posted',
  },
  'ops.daily_closings': {
    group: 'CASH', label: 'Daily cash closing', table: 'daily_cash_closings',
    codeColumn: 'close_no', amountColumn: 'physical_cash', dateColumn: 'close_date',
    dateLabel: 'Close date',
  },
  'ops.requisitions': {
    group: 'SPEND', label: 'Requisition', table: 'requisitions',
    codeColumn: 'req_no', amountColumn: 'estimated_total', dateColumn: 'required_date',
    dateLabel: 'Required by', currencyColumn: 'currency',
    accountColumn: 'account_id', budgetColumn: 'budget_id',
  },
  'hr.payrolls': {
    group: 'PAYROLL', label: 'Payroll run', table: 'payrolls',
    codeColumn: 'payroll_no', amountColumn: 'net_total', dateColumn: 'period_end',
    dateLabel: 'Period end', currencyColumn: 'currency', glPostedColumn: 'gl_posted',
  },
  'assets.transfers': {
    group: 'ASSETS', label: 'Asset transfer', table: 'asset_transfers',
    codeColumn: 'transfer_no', amountColumn: 'total_value', dateColumn: 'created_at',
    dateLabel: 'Raised',
  },
  'assets.disposals': {
    group: 'ASSETS', label: 'Asset disposal', table: 'asset_disposals',
    codeColumn: 'disposal_no', amountColumn: 'sale_price', dateColumn: 'disposal_date',
    dateLabel: 'Disposal date',
  },
  'assets.impairments': {
    group: 'ASSETS', label: 'Asset impairment', table: 'asset_impairments',
    codeColumn: 'impairment_no', amountColumn: 'new_book_value', dateColumn: 'created_at',
    dateLabel: 'Raised',
  },
  'assets.register': {
    group: 'ASSETS', label: 'Asset capitalisation', table: 'asset_register',
    codeColumn: 'asset_no', amountColumn: 'purchase_cost', dateColumn: 'purchase_date',
    dateLabel: 'Purchase date', glPostedColumn: 'capitalized',
  },
  'inventory.adjustments': {
    group: 'SPEND', label: 'Stock adjustment', table: 'inventory_adjustments',
    codeColumn: 'adjustment_no', amountColumn: 'NULL', dateColumn: 'created_at',
    dateLabel: 'Raised',
  },
  'inventory.transfers': {
    group: 'SPEND', label: 'Stock transfer', table: 'inventory_transfers',
    codeColumn: 'transfer_no', amountColumn: 'NULL', dateColumn: 'created_at',
    dateLabel: 'Raised',
  },
};

export interface FinApprovalHistory {
  stepSeq: number | null;
  stepName: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface FinanceApproval {
  taskId: number;
  instanceId: number;
  entityType: string;
  entityId: number;
  code: string;
  label: string;
  group: FinApprovalGroup;
  amount: number | null;
  currency: string | null;
  docDate: string | null;
  dateLabel: string;
  party: string | null;
  workflowName: string | null;
  stepName: string;
  stepSeq: number | null;
  submittedAt: string | null;
  requestedBy: string | null;
  dueAt: string | null;
  overdue: boolean;
  daysWaiting: number | null;
  ledgerEffect: LedgerEffect;
  ledgerNote: string;
  glPosted: boolean | null;
  budget: BudgetPosition | null;
  linkedBudget: { budgetNo: string; amount: number; status: string } | null;
  approvals: FinApprovalHistory[];
}

export interface FinanceApprovalInbox {
  data: FinanceApproval[];
  count: number;
  totals: { currency: string; amount: number }[];
  summary: {
    waiting: number;
    overdue: number;
    dueSoon: number;
    byGroup: { group: FinApprovalGroup; label: string; count: number; amount: number | null }[];
    oldestSubmittedAt: string | null;
  };
}

const DAY = 86_400_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** The ledger consequence of approving, taken from the workflow entity registry. */
function ledgerEffect(entityType: string): { ledgerEffect: LedgerEffect; ledgerNote: string } {
  const onApprove = ENTITIES[entityType]?.onApprove;
  if (onApprove === 'post') {
    return {
      ledgerEffect: 'POSTS_ENTRY',
      ledgerNote: 'Approval posts a balanced double-entry journal to the general ledger.',
    };
  }
  if (onApprove === 'release') {
    return {
      ledgerEffect: 'RELEASES_PAYMENT',
      ledgerNote: 'Approval releases the payment and clears the bank or cash account.',
    };
  }
  if (onApprove === 'authorize') {
    return {
      ledgerEffect: 'POSTS_ENTRY',
      ledgerNote: 'Approval authorises the document; the ledger entry follows on posting.',
    };
  }
  return {
    ledgerEffect: 'RECORD_ONLY',
    ledgerNote: 'This step changes the document status only; no ledger entry is created here.',
  };
}

interface Enriched {
  code: string;
  amount: number | null;
  currency: string | null;
  docDate: string | null;
  glPosted: boolean | null;
  accountId: number | null;
  budgetId: number | null;
  party: string | null;
}

/** Load the documents behind one entity type, with party names resolved. */
async function enrichType(
  client: pg.PoolClient,
  ctx: Ctx,
  entityType: string,
  ids: number[],
  baseCurrency: string | null
): Promise<Map<number, Enriched>> {
  const cfg = DOCS[entityType];
  const out = new Map<number, Enriched>();
  if (!cfg || ids.length === 0) return out;

  const party = cfg.party;
  const res = await client.query(
    `SELECT id,
            ${cfg.codeColumn}::text AS code,
            ${cfg.amountColumn} AS amount,
            ${cfg.currencyColumn ?? 'NULL::text'} AS currency,
            ${cfg.glPostedColumn ?? 'NULL::boolean'} AS gl_posted,
            ${cfg.dateColumn}::text AS doc_date,
            ${cfg.accountColumn ?? 'NULL::bigint'} AS account_id,
            ${cfg.budgetColumn ?? 'NULL::bigint'} AS budget_id,
            ${party && party.kind === 'table' ? `${party.fk} AS party_id` : 'NULL::bigint AS party_id'},
            ${party && party.kind === 'column' ? `${party.column}::text AS party_name` : 'NULL::text AS party_name'}
       FROM ${cfg.table}
      WHERE id = ANY($1::bigint[]) AND company_id = $2 AND tenant_id = $3`,
    [ids, ctx.companyId, ctx.tenantId]
  );

  let nameById = new Map<number, string | null>();
  if (party && party.kind === 'table') {
    const fkIds = [...new Set(res.rows.map((r) => num(r.party_id)).filter((v): v is number => v != null))];
    if (fkIds.length > 0) {
      const pRes = await client.query(
        `SELECT id, ${party.nameColumn} AS name FROM ${party.table} WHERE id = ANY($1::bigint[])`,
        [fkIds]
      );
      nameById = new Map(pRes.rows.map((r) => [Number(r.id), str(r.name)]));
    }
  }

  for (const r of res.rows) {
    const id = Number(r.id);
    const partyId = num(r.party_id);
    out.set(id, {
      code: str(r.code) ?? `#${id}`,
      amount: num(r.amount),
      currency: str(r.currency) ?? baseCurrency,
      docDate: str(r.doc_date),
      glPosted: r.gl_posted === null || r.gl_posted === undefined ? null : Boolean(r.gl_posted),
      accountId: num(r.account_id),
      budgetId: num(r.budget_id),
      party: party && party.kind === 'column' ? str(r.party_name) : (partyId != null ? nameById.get(partyId) ?? null : null),
    });
  }
  return out;
}

export async function listFinanceApprovals(
  client: pg.PoolClient,
  ctx: Ctx,
  userId: number
): Promise<FinanceApprovalInbox> {
  const queue = await getApprovalsQueue(ctx, userId);
  const mine = queue.filter(
    (r) =>
      DOCS[String(r.entity_type ?? '')] != null &&
      ctx.companyId != null &&
      String(r.company_id ?? '') === String(ctx.companyId)
  );

  const empty: FinanceApprovalInbox = {
    data: [],
    count: 0,
    totals: [],
    summary: { waiting: 0, overdue: 0, dueSoon: 0, byGroup: [], oldestSubmittedAt: null },
  };
  if (mine.length === 0) return empty;

  // --- documents, grouped by entity type so each type costs one query ---
  const idsByType = new Map<string, number[]>();
  for (const r of mine) {
    const type = String(r.entity_type);
    const id = Number(r.entity_id);
    if (!Number.isFinite(id)) continue;
    const list = idsByType.get(type);
    if (list) list.push(id);
    else idsByType.set(type, [id]);
  }

  // A document whose table has no currency column is denominated in the
  // company base currency. Without this fallback those amounts land in a
  // phantom "BASE" bucket and split the executive totals in two.
  const baseRes = await client.query(`SELECT currency FROM companies WHERE id = $1`, [ctx.companyId]);
  const baseCurrency = str(baseRes.rows[0]?.currency);

  const enriched = new Map<string, Enriched>();
  for (const [type, ids] of idsByType) {
    const rows = await enrichType(client, ctx, type, [...new Set(ids)], baseCurrency);
    for (const [id, value] of rows) enriched.set(`${type}:${id}`, value);
  }

  // --- budget position per GL account (the real control the approver needs) ---
  const accountIds = [...new Set([...enriched.values()].map((e) => e.accountId).filter((v): v is number => v != null))];
  const budgetByAccount = new Map<number, BudgetPosition>();
  for (const accountId of accountIds) {
    try {
      budgetByAccount.set(accountId, await budgetPosition(client, ctx, accountId));
    } catch {
      // A missing budget line must never block the approval queue.
    }
  }

  // --- linked budget headers, when a document names a budget ---
  const budgetIds = [...new Set([...enriched.values()].map((e) => e.budgetId).filter((v): v is number => v != null))];
  const budgetHeader = new Map<number, { budgetNo: string; amount: number; status: string }>();
  if (budgetIds.length > 0) {
    const bRes = await client.query(
      `SELECT id, budget_no, amount, status FROM budgets
        WHERE id = ANY($1::bigint[]) AND company_id = $2 AND tenant_id = $3`,
      [budgetIds, ctx.companyId, ctx.tenantId]
    );
    for (const r of bRes.rows) {
      budgetHeader.set(Number(r.id), {
        budgetNo: String(r.budget_no),
        amount: num(r.amount) ?? 0,
        status: String(r.status),
      });
    }
  }

  // --- approval history per instance (previous approvals) ---
  const instanceIds = [...new Set(mine.map((r) => Number(r.instance_id)).filter(Number.isFinite))];
  const history = new Map<number, FinApprovalHistory[]>();
  if (instanceIds.length > 0) {
    const hRes = await client.query(
      `SELECT t.instance_id, t.step_seq, t.step_name, t.status, t.comment, t.decided_at,
              NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS decided_by_name
         FROM approval_tasks t
         LEFT JOIN users u ON u.id = t.decided_by
        WHERE t.instance_id = ANY($1::bigint[])
        ORDER BY t.instance_id, t.step_seq`,
      [instanceIds]
    );
    for (const r of hRes.rows) {
      const key = Number(r.instance_id);
      const entry: FinApprovalHistory = {
        stepSeq: num(r.step_seq),
        stepName: str(r.step_name) ?? 'Approval',
        status: String(r.status),
        decidedBy: str(r.decided_by_name),
        decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        comment: str(r.comment),
      };
      const list = history.get(key);
      if (list) list.push(entry);
      else history.set(key, [entry]);
    }
  }

  // --- requester names ---
  const requesterIds = [...new Set(mine.map((r) => Number(r.created_by)).filter(Number.isFinite))];
  const requesterName = new Map<number, string>();
  if (requesterIds.length > 0) {
    const uRes = await client.query(
      `SELECT id, NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS name
         FROM users WHERE id = ANY($1::bigint[])`,
      [requesterIds]
    );
    for (const r of uRes.rows) {
      const name = str(r.name);
      if (name) requesterName.set(Number(r.id), name);
    }
  }

  const now = Date.now();
  const data: FinanceApproval[] = mine.map((r) => {
    const entityType = String(r.entity_type);
    const cfg = DOCS[entityType]!;
    const entityId = Number(r.entity_id);
    const doc = enriched.get(`${entityType}:${entityId}`) ?? {
      code: `#${entityId}`, amount: null, currency: null, docDate: null,
      glPosted: null, accountId: null, budgetId: null, party: null,
    };
    const dueAtRaw = r.due_at ? new Date(r.due_at) : null;
    const submittedRaw = r.submitted_at ? new Date(r.submitted_at) : null;
    const accountId = doc.accountId;
    return {
      taskId: Number(r.task_id),
      instanceId: Number(r.instance_id),
      entityType,
      entityId,
      code: str(r.entity_code) ?? doc.code,
      label: cfg.label,
      group: cfg.group,
      amount: doc.amount,
      currency: doc.currency,
      docDate: doc.docDate,
      dateLabel: cfg.dateLabel,
      party: doc.party,
      workflowName: str(r.workflow_name),
      stepName: str(r.step_name) ?? 'Approval',
      stepSeq: num(r.step_seq),
      submittedAt: submittedRaw ? submittedRaw.toISOString() : null,
      requestedBy: requesterName.get(Number(r.created_by)) ?? null,
      dueAt: dueAtRaw ? dueAtRaw.toISOString() : null,
      overdue: dueAtRaw != null && dueAtRaw.getTime() < now,
      daysWaiting: submittedRaw ? Math.max(0, Math.floor((now - submittedRaw.getTime()) / DAY)) : null,
      ...ledgerEffect(entityType),
      glPosted: doc.glPosted,
      budget: accountId != null ? budgetByAccount.get(accountId) ?? null : null,
      linkedBudget: doc.budgetId != null ? budgetHeader.get(doc.budgetId) ?? null : null,
      approvals: history.get(Number(r.instance_id)) ?? [],
    };
  });

  // Most urgent first: overdue, then longest waiting, then largest value.
  data.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const aw = a.daysWaiting ?? 0;
    const bw = b.daysWaiting ?? 0;
    if (aw !== bw) return bw - aw;
    return (b.amount ?? 0) - (a.amount ?? 0);
  });

  const totalsMap = new Map<string, number>();
  for (const row of data) {
    if (row.amount == null) continue;
    const key = row.currency ?? 'BASE';
    totalsMap.set(key, (totalsMap.get(key) ?? 0) + row.amount);
  }

  const groupLabels: Record<FinApprovalGroup, string> = {
    PAYABLES: 'Payables', RECEIVABLES: 'Receivables', SPEND: 'Spend',
    CASH: 'Cash', PAYROLL: 'Payroll', ASSETS: 'Assets',
  };
  const groupOrder: FinApprovalGroup[] = ['PAYABLES', 'RECEIVABLES', 'SPEND', 'CASH', 'PAYROLL', 'ASSETS'];
  const byGroup = groupOrder
    .map((group) => {
      const rows = data.filter((r) => r.group === group);
      const amounts = rows.map((r) => r.amount).filter((v): v is number => v != null);
      return {
        group,
        label: groupLabels[group],
        count: rows.length,
        amount: amounts.length > 0 ? amounts.reduce((sum, v) => sum + v, 0) : null,
      };
    })
    .filter((g) => g.count > 0);

  const submittedTimes = data
    .map((r) => r.submittedAt)
    .filter((v): v is string => v != null)
    .sort();

  return {
    data,
    count: data.length,
    totals: [...totalsMap.entries()].map(([currency, amount]) => ({ currency, amount })),
    summary: {
      waiting: data.length,
      overdue: data.filter((r) => r.overdue).length,
      dueSoon: data.filter(
        (r) => r.dueAt != null && !r.overdue && new Date(r.dueAt).getTime() - now < 2 * DAY
      ).length,
      byGroup,
      oldestSubmittedAt: submittedTimes[0] ?? null,
    },
  };
}