import pg from 'pg';
import { Ctx } from '../db.js';
import { notFound, toCamelRows } from '../utils.js';

/**
 * Customer intelligence — RFM segmentation, reorder/churn risk, credit risk and
 * next-best-action suggestions.
 *
 * Everything here is derived from existing tables (customers, customer_invoices,
 * sales_quotations) at read time; no schema change is required. The scoring
 * functions are pure and exported so they can be unit-tested without a database.
 *
 * Windows (documented so the numbers are never mysterious):
 *   - Recency  = days since the customer's most recent non-void invoice.
 *   - Frequency & Monetary = invoices / spend over the trailing 365 days.
 *   - Reorder cadence = mean interval between consecutive invoices (all history),
 *     used only when a customer has >= 2 invoices.
 */

export interface CustomerIntelligenceInput {
  customerId: number;
  code: string;
  name: string;
  status: string; // ACTIVE | INACTIVE | BLOCKED | PROSPECT
  creditLimit: number;
  openAr: number; // balance (total - amount_paid) on non-void, non-paid invoices
  overdueAr: number; // balance where due_date < today
  days90Plus: number; // balance 90+ days overdue
  recencyDays: number | null; // days since last non-void invoice; null = never invoiced
  orderCount: number; // invoices in the trailing 365 days
  monetary: number; // spend in the trailing 365 days
  lastOrderDate: string | null;
  avgIntervalDays: number | null; // mean days between invoices (>= 2 invoices)
  expiringQuoteNo: string | null;
  expiringQuoteDate: string | null;
}

export type SegmentKey =
  | 'CHAMPION'
  | 'LOYAL'
  | 'POTENTIAL_LOYALIST'
  | 'PROMISING'
  | 'NEEDS_ATTENTION'
  | 'AT_RISK'
  | 'HIBERNATING'
  | 'LOST'
  | 'NEW'
  | 'INACTIVE';

export interface SegmentMeta {
  label: string;
  description: string;
  tone: 'positive' | 'neutral' | 'warning' | 'danger' | 'muted';
}

export const SEGMENT_META: Record<SegmentKey, SegmentMeta> = {
  CHAMPION: { label: 'Champion', description: 'High value, recent and frequent', tone: 'positive' },
  LOYAL: { label: 'Loyal', description: 'Consistent repeat buyer', tone: 'positive' },
  POTENTIAL_LOYALIST: { label: 'Potential loyalist', description: 'Recent with moderate value', tone: 'neutral' },
  PROMISING: { label: 'Promising', description: 'Recent, low volume so far', tone: 'positive' },
  NEEDS_ATTENTION: { label: 'Needs attention', description: 'Middle of the pack', tone: 'warning' },
  AT_RISK: { label: 'At risk', description: 'Valuable but lapsing', tone: 'warning' },
  HIBERNATING: { label: 'Hibernating', description: 'Gone quiet, historically valuable', tone: 'danger' },
  LOST: { label: 'Lost', description: 'Long inactive, low value', tone: 'danger' },
  NEW: { label: 'New', description: 'No purchase history yet', tone: 'neutral' },
  INACTIVE: { label: 'Inactive', description: 'Blocked or inactive account', tone: 'muted' },
};

function quartiles(values: number[]): [number, number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0, 0];
  const at = (p: number) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/** Score a raw metric into a 1–4 quartile bucket. `higherIsBetter=false` for recency. */
function scoreFor(v: number, q: [number, number, number], higherIsBetter: boolean): number {
  const bucket = v <= q[0] ? 0 : v <= q[1] ? 1 : v <= q[2] ? 2 : 3;
  return (higherIsBetter ? bucket : 3 - bucket) + 1;
}

/** Map R/F/M scores (each 1–4, 4 = best) to a segment. Rules are priority-ordered. */
export function segmentForScores(r: number, f: number, m: number): SegmentKey {
  if (r >= 4 && f >= 4 && m >= 4) return 'CHAMPION';
  if (r >= 3 && f >= 3 && m >= 3) return 'LOYAL';
  if (r <= 1 && f >= 3 && m >= 3) return 'HIBERNATING';
  if (r <= 2 && f >= 3 && m >= 3) return 'AT_RISK'; // r === 2, valuable but lapsing
  if (r <= 1) return 'LOST';
  if (r >= 3 && f >= 3 && m <= 2) return 'POTENTIAL_LOYALIST'; // frequent + recent, low value
  if (r >= 3 && m >= 3 && f <= 2) return 'POTENTIAL_LOYALIST'; // recent + valuable, low frequency
  if (r >= 3) return 'PROMISING'; // recent, low volume and value
  return 'NEEDS_ATTENTION';
}

export interface RfmResult {
  recencyScore: number | null;
  frequencyScore: number | null;
  monetaryScore: number | null;
  segment: SegmentKey;
}

/** Assign RFM scores and a segment to every customer in one pass (quartiles over the trading set). */
export function assignSegments(rows: CustomerIntelligenceInput[]): Map<number, RfmResult> {
  const trading = rows.filter((r) => r.orderCount > 0);
  const rq = quartiles(trading.map((r) => r.recencyDays ?? 0));
  const fq = quartiles(trading.map((r) => r.orderCount));
  const mq = quartiles(trading.map((r) => r.monetary));

  const out = new Map<number, RfmResult>();
  for (const r of rows) {
    if (r.orderCount === 0) {
      const segment: SegmentKey = r.status === 'INACTIVE' || r.status === 'BLOCKED' ? 'INACTIVE' : 'NEW';
      out.set(r.customerId, { recencyScore: null, frequencyScore: null, monetaryScore: null, segment });
      continue;
    }
    const recencyScore = scoreFor(r.recencyDays ?? 0, rq, false);
    const frequencyScore = scoreFor(r.orderCount, fq, true);
    const monetaryScore = scoreFor(r.monetary, mq, true);
    out.set(r.customerId, {
      recencyScore,
      frequencyScore,
      monetaryScore,
      segment: segmentForScores(recencyScore, frequencyScore, monetaryScore),
    });
  }
  return out;
}

export interface ChurnResult {
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  label: string;
  expectedReorderDays: number | null;
  overdueDays: number | null;
  reason: string;
}

/** Reorder/churn risk from purchase cadence. */
export function churnRiskLevel(r: CustomerIntelligenceInput): ChurnResult {
  if (r.orderCount === 0) {
    return { level: 'LOW', label: 'No history', expectedReorderDays: null, overdueDays: null, reason: 'No purchase history yet' };
  }
  if (r.recencyDays == null) {
    return { level: 'LOW', label: 'Active', expectedReorderDays: null, overdueDays: null, reason: 'Recently ordered' };
  }
  if (r.avgIntervalDays == null) {
    // Single purchase — flag only after a generous quiet period.
    const level = r.recencyDays > 90 ? 'MEDIUM' : 'LOW';
    return {
      level,
      label: level === 'MEDIUM' ? 'Going quiet' : 'Active',
      expectedReorderDays: null,
      overdueDays: r.recencyDays > 90 ? r.recencyDays - 90 : null,
      reason: level === 'MEDIUM' ? `Single purchase, ${r.recencyDays}d ago` : 'Single purchase, recent',
    };
  }
  const expectedReorderDays = Math.round(r.avgIntervalDays);
  const overdueDays = r.recencyDays - expectedReorderDays;
  if (overdueDays > expectedReorderDays) {
    return {
      level: 'HIGH',
      label: 'At risk of churn',
      expectedReorderDays,
      overdueDays,
      reason: `${r.recencyDays}d since last order (usual cadence ${expectedReorderDays}d)`,
    };
  }
  if (overdueDays > 0) {
    return {
      level: 'MEDIUM',
      label: 'Past due to reorder',
      expectedReorderDays,
      overdueDays,
      reason: `${overdueDays}d past expected reorder (cadence ${expectedReorderDays}d)`,
    };
  }
  return {
    level: 'LOW',
    label: 'On cadence',
    expectedReorderDays,
    overdueDays,
    reason: `On cadence (next expected in ${-overdueDays}d)`,
  };
}

export interface CreditRiskResult {
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  label: string;
  reasons: string[];
}

/** Consolidated credit risk from status, limit utilisation and AR aging. */
export function creditRiskLevel(r: CustomerIntelligenceInput): CreditRiskResult {
  if (r.status === 'BLOCKED') {
    return { level: 'CRITICAL', label: 'Blocked', reasons: ['Account is blocked'] };
  }
  if (r.status === 'INACTIVE') {
    return { level: 'CRITICAL', label: 'Inactive', reasons: ['Account is inactive'] };
  }
  const reasons: string[] = [];
  if (r.creditLimit > 0 && r.openAr > r.creditLimit) reasons.push('Over credit limit');
  if (r.days90Plus > 0) reasons.push('AR past 90 days');
  else if (r.overdueAr > 0) reasons.push('Overdue AR');
  if (reasons.length === 0) return { level: 'LOW', label: 'Healthy', reasons: [] };
  const level: CreditRiskResult['level'] = r.creditLimit > 0 && r.openAr > r.creditLimit ? 'HIGH'
    : r.days90Plus > 0 ? 'HIGH' : 'MEDIUM';
  return { level, label: level === 'HIGH' ? 'High risk' : 'Watch', reasons };
}

export interface Action {
  type: 'collect' | 'reengage' | 'credit' | 'quote' | 'nurture';
  title: string;
  detail: string;
  severity: 'critical' | 'warn' | 'info';
  href: string;
}

const money = (n: number) => {
  const abs = Math.abs(n);
  const v = abs >= 1e9 ? `${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M` : abs >= 1e3 ? `${(abs / 1e3).toFixed(0)}k` : String(Math.round(abs));
  return `${n < 0 ? '-' : ''}UGX ${v}`;
};

/** Produce 0–3 priority-ordered next-best-actions for a customer. */
export function nextBestActions(
  r: CustomerIntelligenceInput,
  rfm: RfmResult,
  churn: ChurnResult,
  credit: CreditRiskResult
): Action[] {
  const actions: Action[] = [];
  const customerHref = `/crm/customers/${r.customerId}`;

  if (r.overdueAr > 0) {
    actions.push({
      type: 'collect',
      title: 'Collect overdue balance',
      detail: `${money(r.overdueAr)} past due`,
      severity: 'critical',
      href: '/finance/ar',
    });
  }
  if (churn.level === 'HIGH') {
    actions.push({
      type: 'reengage',
      title: 'Re-engage this customer',
      detail: churn.reason,
      severity: 'warn',
      href: customerHref,
    });
  }
  if (credit.level === 'HIGH' || credit.level === 'CRITICAL') {
    actions.push({
      type: 'credit',
      title: 'Review credit before next order',
      detail: credit.reasons.join('; '),
      severity: 'warn',
      href: customerHref,
    });
  }
  if (r.expiringQuoteNo) {
    actions.push({
      type: 'quote',
      title: 'Follow up expiring quotation',
      detail: `${r.expiringQuoteNo}${r.expiringQuoteDate ? ` · expires ${r.expiringQuoteDate}` : ''}`,
      severity: 'info',
      href: '/sales/quotations',
    });
  }
  if (actions.length === 0 && r.orderCount === 0) {
    actions.push({
      type: 'nurture',
      title: 'Win the first order',
      detail: 'No invoice history yet — nurture this account',
      severity: 'info',
      href: customerHref,
    });
  }
  if (actions.length === 0 && rfm.segment === 'AT_RISK') {
    actions.push({
      type: 'reengage',
      title: 'Priority re-engagement',
      detail: 'Valuable account is lapsing',
      severity: 'warn',
      href: customerHref,
    });
  }
  return actions.slice(0, 3);
}

export interface EnrichedCustomer extends CustomerIntelligenceInput {
  rfm: RfmResult;
  churn: ChurnResult;
  credit: CreditRiskResult;
  actions: Action[];
}

/** Run the pure scoring pipeline over raw metrics rows. */
export function enrich(rows: CustomerIntelligenceInput[]): EnrichedCustomer[] {
  const rfmMap = assignSegments(rows);
  return rows.map((r) => {
    const rfm = rfmMap.get(r.customerId)!;
    const churn = churnRiskLevel(r);
    const credit = creditRiskLevel(r);
    const actions = nextBestActions(r, rfm, churn, credit);
    return { ...r, rfm, churn, credit, actions };
  });
}

const METRICS_SQL = `
  SELECT
    c.id AS customer_id,
    c.code,
    c.name,
    c.status,
    COALESCE(c.credit_limit, 0)::numeric AS credit_limit,
    COALESCE((
      SELECT sum(i.total - i.amount_paid) FROM customer_invoices i
       WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID')
    ), 0)::numeric AS open_ar,
    COALESCE((
      SELECT sum(i.total - i.amount_paid) FROM customer_invoices i
       WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID') AND i.due_date < CURRENT_DATE
    ), 0)::numeric AS overdue_ar,
    COALESCE((
      SELECT sum(i.total - i.amount_paid) FROM customer_invoices i
       WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID') AND i.due_date < CURRENT_DATE - 90
    ), 0)::numeric AS days_90_plus,
    agg.last_order_date,
    agg.recency_days,
    agg.order_count,
    agg.monetary,
    agg.avg_interval_days,
    q.quotation_no AS expiring_quote_no,
    q.valid_until::text AS expiring_quote_date
  FROM customers c
  LEFT JOIN (
    SELECT customer_id,
      max(invoice_date) AS last_order_date,
      (CURRENT_DATE - max(invoice_date))::int AS recency_days,
      count(*) FILTER (WHERE invoice_date >= CURRENT_DATE - 365)::int AS order_count,
      COALESCE(sum(total) FILTER (WHERE invoice_date >= CURRENT_DATE - 365), 0)::numeric AS monetary,
      CASE WHEN count(*) >= 2
        THEN (max(invoice_date) - min(invoice_date))::numeric / (count(*) - 1)
        ELSE NULL END AS avg_interval_days
    FROM customer_invoices
    WHERE status NOT IN ('DRAFT','VOID')
    GROUP BY customer_id
  ) agg ON agg.customer_id = c.id
  LEFT JOIN (
    SELECT DISTINCT ON (customer_id) customer_id, quotation_no, valid_until
    FROM sales_quotations
    WHERE status IN ('DRAFT','SUBMITTED','APPROVED')
      AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
    ORDER BY customer_id, valid_until
  ) q ON q.customer_id = c.id
`;

function toInput(row: Record<string, unknown>): CustomerIntelligenceInput {
  return {
    customerId: Number(row.customer_id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    status: String(row.status ?? 'ACTIVE'),
    creditLimit: Number(row.credit_limit ?? 0),
    openAr: Number(row.open_ar ?? 0),
    overdueAr: Number(row.overdue_ar ?? 0),
    days90Plus: Number(row.days_90_plus ?? 0),
    recencyDays: row.recency_days == null ? null : Number(row.recency_days),
    orderCount: Number(row.order_count ?? 0),
    monetary: Number(row.monetary ?? 0),
    lastOrderDate: row.last_order_date == null ? null : String(row.last_order_date).slice(0, 10),
    avgIntervalDays: row.avg_interval_days == null ? null : Number(row.avg_interval_days),
    expiringQuoteNo: row.expiring_quote_no == null ? null : String(row.expiring_quote_no),
    expiringQuoteDate: row.expiring_quote_date == null ? null : String(row.expiring_quote_date).slice(0, 10),
  };
}

function toOutput(e: EnrichedCustomer) {
  const seg = SEGMENT_META[e.rfm.segment];
  return {
    customerId: e.customerId,
    code: e.code,
    name: e.name,
    status: e.status,
    creditLimit: e.creditLimit,
    openAr: e.openAr,
    overdueAr: e.overdueAr,
    lastOrderDate: e.lastOrderDate,
    recencyDays: e.recencyDays,
    orderCount: e.orderCount,
    monetary: e.monetary,
    avgIntervalDays: e.avgIntervalDays,
    segment: e.rfm.segment,
    segmentLabel: seg.label,
    segmentTone: seg.tone,
    recencyScore: e.rfm.recencyScore,
    frequencyScore: e.rfm.frequencyScore,
    monetaryScore: e.rfm.monetaryScore,
    churnLevel: e.churn.level,
    churnLabel: e.churn.label,
    churnReason: e.churn.reason,
    expectedReorderDays: e.churn.expectedReorderDays,
    creditLevel: e.credit.level,
    creditLabel: e.credit.label,
    creditReasons: e.credit.reasons,
    actions: e.actions,
  };
}

export interface IntelligenceFilters {
  q?: string;
  segment?: string;
  churn?: string;
  credit?: string;
  page?: number;
  pageSize?: number;
}

/** List customers with their intelligence layer, filterable. */
export async function listCustomerIntelligence(client: pg.PoolClient, ctx: Ctx, filters: IntelligenceFilters = {}) {
  const clauses: string[] = ['c.tenant_id = $1', 'c.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];

  if (filters.q) {
    params.push(`%${filters.q}%`);
    clauses.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`);
  }
  // segment / churn / credit are computed, so they are filtered in-memory after enrichment.

  const r = await client.query(`${METRICS_SQL} WHERE ${clauses.join(' AND ')} ORDER BY c.name ASC`, params);
  let rows = enrich(r.rows.map((x) => toInput(x)));

  if (filters.segment) rows = rows.filter((e) => e.rfm.segment === filters.segment);
  if (filters.churn) rows = rows.filter((e) => e.churn.level === filters.churn);
  if (filters.credit) rows = rows.filter((e) => e.credit.level === filters.credit);

  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize).map(toOutput);
  return { items, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

/** Aggregate KPIs + segment distribution for the intelligence board. */
export async function customerIntelligenceOverview(client: pg.PoolClient, ctx: Ctx) {
  const r = await client.query(`${METRICS_SQL} WHERE c.tenant_id = $1 AND c.company_id = $2 ORDER BY c.name ASC`, [ctx.tenantId, ctx.companyId]);
  const rows = enrich(r.rows.map((x) => toInput(x)));

  const counts = { total: rows.length, trading: 0, churnHigh: 0, creditHigh: 0, creditCritical: 0, atRiskSegments: 0 };
  let openAr = 0;
  let revenue12m = 0;
  const segments = new Map<string, { count: number; revenue: number; openAr: number }>();

  for (const e of rows) {
    if (e.orderCount > 0) counts.trading += 1;
    if (e.churn.level === 'HIGH') counts.churnHigh += 1;
    if (e.credit.level === 'HIGH') counts.creditHigh += 1;
    if (e.credit.level === 'CRITICAL') counts.creditCritical += 1;
    if (['AT_RISK', 'HIBERNATING', 'LOST'].includes(e.rfm.segment)) counts.atRiskSegments += 1;
    openAr += e.openAr;
    revenue12m += e.monetary;

    const s = segments.get(e.rfm.segment) ?? { count: 0, revenue: 0, openAr: 0 };
    s.count += 1;
    s.revenue += e.monetary;
    s.openAr += e.openAr;
    segments.set(e.rfm.segment, s);
  }

  const segmentRows = [...segments.entries()]
    .map(([key, v]) => ({
      segment: key,
      segmentLabel: SEGMENT_META[key as SegmentKey].label,
      segmentTone: SEGMENT_META[key as SegmentKey].tone,
      count: v.count,
      revenue: v.revenue,
      openAr: v.openAr,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis: {
      totalCustomers: counts.total,
      tradingCustomers: counts.trading,
      churnAtRisk: counts.churnHigh,
      creditAtRisk: counts.creditHigh + counts.creditCritical,
      atRiskSegments: counts.atRiskSegments,
      openAr,
      revenue12m,
    },
    segments: segmentRows,
  };
}

/** Single-customer intelligence block (surfaced on the account 360). */
export async function customerIntelligence(client: pg.PoolClient, ctx: Ctx, customerId: number) {
  const r = await client.query(
    `${METRICS_SQL} WHERE c.tenant_id = $1 AND c.company_id = $2 AND c.id = $3`,
    [ctx.tenantId, ctx.companyId, customerId]
  );
  if (r.rows.length === 0) throw notFound('Customer not found');
  // Enrich against a light reference set so RFM quartiles are not degenerate for one row.
  const ref = await client.query(
    `${METRICS_SQL} WHERE c.tenant_id = $1 AND c.company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const enriched = enrich(ref.rows.map((x) => toInput(x)));
  const mine = enriched.find((e) => e.customerId === customerId)!;
  return toOutput(mine);
}
