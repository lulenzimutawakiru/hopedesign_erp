import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, forbidden, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import * as sales from './sales.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const PIPELINE_STAGES = [
  'PROSPECTING',
  'QUALIFICATION',
  'NEEDS_ANALYSIS',
  'VALUE_PROPOSITION',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;

const STAGE_PROB: Record<string, number> = {
  PROSPECTING: 10,
  QUALIFICATION: 25,
  NEEDS_ANALYSIS: 40,
  VALUE_PROPOSITION: 60,
  NEGOTIATION: 80,
  WON: 100,
  LOST: 0,
};

const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED', 'PROSPECT'] as const;

function scoreLead(input: {
  source?: string | null;
  value?: number;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
}): number {
  let score = 10;
  if (input.companyName?.trim()) score += 15;
  if (input.email?.trim()) score += 10;
  if (input.phone?.trim()) score += 10;
  const value = Number(input.value ?? 0);
  if (value > 0) score += 15;
  if (value >= 1_000_000) score += 10;
  if (['REFERRAL', 'EXISTING'].includes(String(input.source ?? ''))) score += 20;
  if (input.source === 'WEBSITE' || input.source === 'TRADE_SHOW') score += 10;
  return Math.min(100, score);
}

function healthBand(score: number): 'healthy' | 'watch' | 'risk' | 'critical' {
  if (score >= 80) return 'healthy';
  if (score >= 55) return 'watch';
  if (score >= 30) return 'risk';
  return 'critical';
}

async function logSystemActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { entityType: string; entityId: number; activityType?: string; subject: string; notes?: string | null }
) {
  if (!ctx.companyId || !input.subject.trim()) return;
  await client.query(
    `INSERT INTO activities
       (company_id, tenant_id, entity_type, entity_id, activity_type, subject, notes, assigned_to, created_by, done, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,true,now())`,
    [
      ctx.companyId, ctx.tenantId, input.entityType, input.entityId,
      input.activityType ?? 'NOTE', input.subject.trim(), input.notes ?? null, ctx.userId ?? null,
    ]
  );
}

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

async function requireCompany(ctx: Ctx): Promise<number> {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

export async function creditCheck(client: pg.PoolClient, ctx: Ctx, customerId: number, extraAmount = 0) {
  const res = await client.query(
    `SELECT c.id, c.code, c.name, c.status, c.credit_limit,
            COALESCE((
              SELECT sum(i.total - i.amount_paid)
              FROM customer_invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID')
            ), 0)::numeric AS open_ar
     FROM customers c WHERE c.id = $1 AND c.tenant_id = $2`,
    [customerId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Customer not found');
  const row = res.rows[0];
  const limit = Number(row.credit_limit) || 0;
  const openAr = Number(row.open_ar) || 0;
  const exposure = openAr + Number(extraAmount || 0);
  const available = limit > 0 ? round2(limit - exposure) : null;
  const blocked = String(row.status) === 'BLOCKED' || String(row.status) === 'INACTIVE';
  const overLimit = limit > 0 && exposure > limit;
  return {
    customerId,
    code: String(row.code),
    name: String(row.name),
    status: String(row.status),
    creditLimit: limit,
    openAr,
    extraAmount: Number(extraAmount || 0),
    exposure,
    available,
    ok: !blocked && !overLimit,
    reason: blocked ? `Customer is ${row.status}` : overLimit ? 'Credit limit exceeded' : null,
  };
}

function assertTradable(check: { ok: boolean; reason: string | null }) {
  if (!check.ok) throw badRequest(check.reason ?? 'Customer cannot trade');
}

export async function createCustomer(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    name: string;
    customerType?: string;
    tin?: string | null;
    vrn?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    creditLimit?: number;
    paymentTermsDays?: number;
    status?: string;
    notes?: string | null;
  }
) {
  const companyId = await requireCompany(ctx);
  if (!input.name?.trim()) throw badRequest('Customer name is required');
  const code = await nextDoc(client, ctx, 'CUST');
  const status = input.status && ['ACTIVE', 'PROSPECT'].includes(input.status) ? input.status : 'ACTIVE';
  const ins = await client.query(
    `INSERT INTO customers
       (company_id, tenant_id, branch_id, code, name, customer_type, tin, vrn, phone, email, address,
        credit_limit, payment_terms_days, status, owner_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, code, input.name.trim(),
      input.customerType ?? 'COMPANY', input.tin ?? null, input.vrn ?? null,
      input.phone ?? null, input.email ?? null, input.address ?? null,
      Number(input.creditLimit ?? 0), Number(input.paymentTermsDays ?? 30),
      status, ctx.userId ?? null,
    ]
  );
  const customerId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'crm.customer_created', entityType: 'customers', entityId: customerId, entityCode: code });
  await logAudit(client, ctx, { action: 'create', resource: 'customers', recordId: customerId, recordCode: code, newValues: { name: input.name } });
  const duplicates = await findDuplicates(client, ctx, {
    name: input.name,
    email: input.email,
    phone: input.phone,
    excludeCustomerId: customerId,
  });
  return { customerId, code, duplicates };
}

export async function createContact(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { customerId: number; firstName: string; lastName: string; title?: string | null; email?: string | null; phone?: string | null; isPrimary?: boolean }
) {
  const cust = await client.query(`SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`, [input.customerId, ctx.tenantId]);
  if (cust.rows.length === 0) throw notFound('Customer not found');
  if (!input.firstName?.trim() || !input.lastName?.trim()) throw badRequest('Contact name is required');
  if (input.isPrimary) {
    await client.query(`UPDATE contacts SET is_primary = false WHERE customer_id = $1`, [input.customerId]);
  }
  const ins = await client.query(
    `INSERT INTO contacts (customer_id, first_name, last_name, title, email, phone, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.customerId, input.firstName.trim(), input.lastName.trim(), input.title ?? null, input.email ?? null, input.phone ?? null, Boolean(input.isPrimary)]
  );
  return { contactId: Number(ins.rows[0].id) };
}

export async function createLead(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    email?: string | null;
    phone?: string | null;
    source?: string;
    value?: number;
    notes?: string | null;
  }
) {
  const companyId = await requireCompany(ctx);
  if (!input.companyName?.trim() && !input.firstName?.trim() && !input.lastName?.trim()) {
    throw badRequest('Give a company or a person name');
  }
  const leadNo = await nextDoc(client, ctx, 'LEAD');
  const score = scoreLead(input);
  const ins = await client.query(
    `INSERT INTO leads
       (company_id, tenant_id, branch_id, lead_no, first_name, last_name, company_name, email, phone,
        source, status, stage, value, owner_user_id, assigned_to, notes, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NEW','NEW',$11,$12,$12,$13,$14::jsonb) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, leadNo,
      input.firstName ?? null, input.lastName ?? null, input.companyName ?? null,
      input.email ?? null, input.phone ?? null, input.source ?? 'OTHER',
      Number(input.value ?? 0), ctx.userId ?? null, input.notes ?? null,
      JSON.stringify({ score }),
    ]
  );
  const leadId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'crm.lead_created', entityType: 'leads', entityId: leadId, entityCode: leadNo });
  const duplicates = await findDuplicates(client, ctx, {
    name: input.companyName || `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim(),
    email: input.email,
    phone: input.phone,
    excludeLeadId: leadId,
  });
  return { leadId, leadNo, score, duplicates };
}

export async function qualifyLead(client: pg.PoolClient, ctx: Ctx, leadId: number) {
  const res = await client.query(
    `UPDATE leads
        SET status = 'QUALIFIED', stage = 'QUALIFIED',
            attributes = COALESCE(attributes, '{}'::jsonb)
              || jsonb_build_object('score', GREATEST(COALESCE((attributes->>'score')::int, 0), 60))
     WHERE id = $1 AND tenant_id = $2 AND status IN ('NEW','CONTACTED')
     RETURNING lead_no`,
    [leadId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Lead not found or not qualifying');
  await logSystemActivity(client, ctx, {
    entityType: 'leads', entityId: leadId, activityType: 'NOTE', subject: 'Lead qualified',
  });
  return { leadId, leadNo: res.rows[0].lead_no, status: 'QUALIFIED' };
}

export async function convertLead(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { leadId: number; createOpportunity?: boolean; amount?: number }
) {
  const res = await client.query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [input.leadId, ctx.tenantId]);
  if (res.rows.length === 0) throw notFound('Lead not found');
  const lead = res.rows[0];
  if (String(lead.status) === 'CONVERTED') throw badRequest('Lead already converted');
  if (['DISQUALIFIED', 'LOST'].includes(String(lead.status))) throw badRequest(`Cannot convert a ${lead.status} lead`);

  const name = String(lead.company_name || `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || lead.lead_no);
  const customer = await createCustomer(client, ctx, {
    name,
    phone: lead.phone,
    email: lead.email,
    status: 'ACTIVE',
    creditLimit: 0,
  });
  if (lead.first_name || lead.last_name) {
    await createContact(client, ctx, {
      customerId: customer.customerId,
      firstName: String(lead.first_name || name),
      lastName: String(lead.last_name || '—'),
      email: lead.email,
      phone: lead.phone,
      isPrimary: true,
    });
  }

  let opportunityId: number | null = null;
  let opportunityName: string | null = null;
  if (input.createOpportunity !== false) {
    const opp = await createOpportunity(client, ctx, {
      customerId: customer.customerId,
      leadId: input.leadId,
      name: `${name} · from ${lead.lead_no}`,
      amount: Number(input.amount ?? lead.value ?? 0),
      stage: 'QUALIFICATION',
    });
    opportunityId = opp.opportunityId;
    opportunityName = opp.name;
  }

  await client.query(
    `UPDATE leads SET status = 'CONVERTED', stage = 'CONVERTED', converted_customer_id = $2, converted_at = now()
     WHERE id = $1`,
    [input.leadId, customer.customerId]
  );
  await emitEvent(client, ctx, {
    eventType: 'crm.lead_converted',
    entityType: 'leads',
    entityId: input.leadId,
    entityCode: String(lead.lead_no),
    payload: { customerId: customer.customerId, opportunityId },
  });
  await logAudit(client, ctx, {
    action: 'convert',
    resource: 'leads',
    recordId: input.leadId,
    recordCode: String(lead.lead_no),
    newValues: { customerId: customer.customerId, opportunityId },
  });
  await logSystemActivity(client, ctx, {
    entityType: 'customers',
    entityId: customer.customerId,
    activityType: 'NOTE',
    subject: `Converted from ${lead.lead_no}`,
    notes: name,
  });
  return {
    leadId: input.leadId,
    leadNo: lead.lead_no,
    customerId: customer.customerId,
    customerCode: customer.code,
    opportunityId,
    opportunityName,
  };
}

export async function createOpportunity(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    customerId: number;
    leadId?: number | null;
    name: string;
    amount?: number;
    stage?: string;
    expectedClose?: string | null;
    notes?: string | null;
  }
) {
  const companyId = await requireCompany(ctx);
  const cust = await client.query(`SELECT id, status FROM customers WHERE id = $1 AND tenant_id = $2`, [input.customerId, ctx.tenantId]);
  if (cust.rows.length === 0) throw notFound('Customer not found');
  if (['BLOCKED', 'INACTIVE'].includes(String(cust.rows[0].status))) {
    throw badRequest(`Cannot open an opportunity on a ${cust.rows[0].status} account`);
  }
  if (!input.name?.trim()) throw badRequest('Opportunity name is required');
  const stage = input.stage && PIPELINE_STAGES.includes(input.stage as typeof PIPELINE_STAGES[number])
    ? input.stage
    : 'PROSPECTING';
  if (stage === 'WON' || stage === 'LOST') throw badRequest('Create the opportunity open, then win or lose it');
  const ins = await client.query(
    `INSERT INTO opportunities
       (company_id, tenant_id, customer_id, lead_id, name, stage, amount, probability, expected_close, owner_user_id, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11) RETURNING id, name`,
    [
      companyId, ctx.tenantId, input.customerId, input.leadId ?? null, input.name.trim(),
      stage, Number(input.amount ?? 0), STAGE_PROB[stage] ?? 10,
      input.expectedClose ?? null, ctx.userId ?? null, input.notes ?? null,
    ]
  );
  const opportunityId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'crm.opportunity_created', entityType: 'opportunities', entityId: opportunityId, entityCode: input.name });
  return { opportunityId, name: String(ins.rows[0].name) };
}

export async function moveOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number, stage: string) {
  if (!PIPELINE_STAGES.includes(stage as typeof PIPELINE_STAGES[number])) throw badRequest('Unknown pipeline stage');
  if (stage === 'WON') return winOpportunity(client, ctx, opportunityId);
  if (stage === 'LOST') return loseOpportunity(client, ctx, opportunityId, 'Moved to lost');
  const res = await client.query(
    `UPDATE opportunities SET stage = $3, probability = $4, status = 'OPEN'
     WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','ON_HOLD')
     RETURNING name`,
    [opportunityId, ctx.tenantId, stage, STAGE_PROB[stage] ?? 10]
  );
  if (res.rows.length === 0) throw badRequest('Opportunity not found or already closed');
  return { opportunityId, stage, status: 'OPEN' };
}

export async function winOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number) {
  const res = await client.query(
    `UPDATE opportunities SET stage = 'WON', status = 'WON', probability = 100
     WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','ON_HOLD')
     RETURNING name, customer_id`,
    [opportunityId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Opportunity not found or already closed');
  await emitEvent(client, ctx, { eventType: 'crm.opportunity_won', entityType: 'opportunities', entityId: opportunityId, entityCode: String(res.rows[0].name) });
  if (res.rows[0].customer_id) {
    await logSystemActivity(client, ctx, {
      entityType: 'customers',
      entityId: Number(res.rows[0].customer_id),
      activityType: 'NOTE',
      subject: `Won ${res.rows[0].name}`,
    });
  }
  return { opportunityId, status: 'WON', customerId: Number(res.rows[0].customer_id) };
}

export async function loseOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number, reason?: string | null) {
  const res = await client.query(
    `UPDATE opportunities SET stage = 'LOST', status = 'LOST', probability = 0, notes = COALESCE($3, notes)
     WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','ON_HOLD')
     RETURNING name`,
    [opportunityId, ctx.tenantId, reason ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Opportunity not found or already closed');
  await emitEvent(client, ctx, { eventType: 'crm.opportunity_lost', entityType: 'opportunities', entityId: opportunityId, entityCode: String(res.rows[0].name) });
  return { opportunityId, status: 'LOST' };
}

export async function quoteFromOpportunity(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    opportunityId: number;
    items: sales.SalesLineInput[];
    validUntil?: string | null;
    notes?: string | null;
  }
) {
  const res = await client.query(
    `SELECT * FROM opportunities WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.opportunityId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Opportunity not found');
  const opp = res.rows[0];
  if (!opp.customer_id) throw badRequest('Opportunity has no customer');
  if (String(opp.status) === 'LOST') throw badRequest('Cannot quote a lost opportunity');
  if (String(opp.status) === 'ON_HOLD') throw badRequest('Resume the opportunity before quoting');
  if (!input.items?.length) throw badRequest('Add at least one line');
  const amount = input.items.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0);
  const check = await creditCheck(client, ctx, Number(opp.customer_id), amount);
  assertTradable(check);
  const quote = await sales.createQuotation(client, ctx, {
    customerId: Number(opp.customer_id),
    opportunityId: input.opportunityId,
    validUntil: input.validUntil ?? null,
    notes: input.notes ?? `From opportunity ${opp.name}`,
    items: input.items,
  });
  if (String(opp.stage) === 'PROSPECTING' || String(opp.stage) === 'QUALIFICATION') {
    await client.query(
      `UPDATE opportunities SET stage = 'VALUE_PROPOSITION', probability = $2, amount = GREATEST(amount, $3) WHERE id = $1`,
      [input.opportunityId, STAGE_PROB.VALUE_PROPOSITION, round2(amount)]
    );
  } else {
    await client.query(
      `UPDATE opportunities SET amount = GREATEST(amount, $2) WHERE id = $1`,
      [input.opportunityId, round2(amount)]
    );
  }
  await logSystemActivity(client, ctx, {
    entityType: 'opportunities',
    entityId: input.opportunityId,
    activityType: 'NOTE',
    subject: `Quotation ${quote.quotationNo ?? quote.quotationId} issued`,
  });
  return { ...quote, opportunityId: input.opportunityId, credit: check };
}

export async function createActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    entityType: string;
    entityId: number;
    activityType?: string;
    subject: string;
    notes?: string | null;
    dueAt?: string | null;
    assignedTo?: number | null;
  }
) {
  const companyId = await requireCompany(ctx);
  if (!input.subject?.trim()) throw badRequest('Subject is required');
  const type = input.activityType ?? 'FOLLOW_UP';
  const ins = await client.query(
    `INSERT INTO activities
       (company_id, tenant_id, entity_type, entity_id, activity_type, subject, notes, due_at, assigned_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      companyId, ctx.tenantId, input.entityType, input.entityId, type,
      input.subject.trim(), input.notes ?? null, input.dueAt ?? null,
      input.assignedTo ?? ctx.userId ?? null, ctx.userId ?? null,
    ]
  );
  return { activityId: Number(ins.rows[0].id) };
}

export async function completeActivity(client: pg.PoolClient, ctx: Ctx, activityId: number) {
  const res = await client.query(
    `UPDATE activities SET done = true, completed_at = now()
     WHERE id = $1 AND tenant_id = $2 AND done = false RETURNING subject`,
    [activityId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Activity not found or already done');
  return { activityId, done: true };
}

export async function createComplaint(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { customerId: number; subject: string; description?: string | null; priority?: string }
) {
  const companyId = await requireCompany(ctx);
  const cust = await client.query(`SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`, [input.customerId, ctx.tenantId]);
  if (cust.rows.length === 0) throw notFound('Customer not found');
  if (!input.subject?.trim()) throw badRequest('Subject is required');
  const complaintNo = await nextDoc(client, ctx, 'CMP');
  const ins = await client.query(
    `INSERT INTO complaints
       (company_id, tenant_id, customer_id, complaint_no, subject, description, priority, status, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8) RETURNING id`,
    [
      companyId, ctx.tenantId, input.customerId, complaintNo, input.subject.trim(),
      input.description ?? null, input.priority ?? 'MEDIUM', ctx.userId ?? null,
    ]
  );
  const complaintId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'crm.complaint_opened',
    entityType: 'complaints',
    entityId: complaintId,
    entityCode: complaintNo,
    severity: input.priority === 'CRITICAL' || input.priority === 'HIGH' ? 'WARN' : 'INFO',
  });
  return { complaintId, complaintNo };
}

export async function resolveComplaint(client: pg.PoolClient, ctx: Ctx, complaintId: number, resolution: string) {
  const res = await client.query(
    `UPDATE complaints SET status = 'RESOLVED', resolution = $3, closed_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','IN_PROGRESS','ESCALATED')
     RETURNING complaint_no`,
    [complaintId, ctx.tenantId, resolution || 'Resolved']
  );
  if (res.rows.length === 0) throw badRequest('Complaint not found or already closed');
  return { complaintId, complaintNo: res.rows[0].complaint_no, status: 'RESOLVED' };
}

export async function escalateComplaint(client: pg.PoolClient, ctx: Ctx, complaintId: number) {
  const res = await client.query(
    `UPDATE complaints SET status = 'ESCALATED', priority = CASE WHEN priority IN ('LOW','MEDIUM') THEN 'HIGH' ELSE priority END
     WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','IN_PROGRESS')
     RETURNING complaint_no`,
    [complaintId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Complaint not found or cannot escalate');
  return { complaintId, complaintNo: res.rows[0].complaint_no, status: 'ESCALATED' };
}

export async function listCustomers(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['c.tenant_id = $1', 'c.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(c.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`c.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT c.id, c.code, c.name, c.customer_type, c.status, c.phone, c.email, c.credit_limit, c.payment_terms_days,
            c.owner_user_id,
            TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS owner_name,
            COALESCE((
              SELECT sum(i.total - i.amount_paid) FROM customer_invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID')
            ),0)::numeric AS open_ar,
            (SELECT count(*) FROM opportunities o WHERE o.customer_id = c.id AND o.status = 'OPEN')::int AS open_opps
     FROM customers c
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function getCustomer360(client: pg.PoolClient, ctx: Ctx, customerId: number) {
  const res = await client.query(
    `SELECT c.*, TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS owner_name
     FROM customers c LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [customerId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Customer not found');
  const contacts = await client.query(`SELECT * FROM contacts WHERE customer_id = $1 ORDER BY is_primary DESC, id`, [customerId]);
  const opps = await client.query(`SELECT id, name, stage, status, amount, probability, expected_close, created_at FROM opportunities WHERE customer_id = $1 ORDER BY id DESC`, [customerId]);
  const quotes = await client.query(`SELECT id, quotation_no, status, total, quotation_date FROM sales_quotations WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`, [customerId]);
  const orders = await client.query(`SELECT id, order_no, status, total, order_date FROM sales_orders WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`, [customerId]);
  const invoices = await client.query(
    `SELECT id, invoice_no, status, total, amount_paid, (total - amount_paid) AS balance, due_date, invoice_date
     FROM customer_invoices WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`,
    [customerId]
  );
  const activities = await client.query(
    `SELECT id, activity_type, subject, notes, due_at, done, assigned_to, created_at, completed_at FROM activities
     WHERE tenant_id = $1 AND ((entity_type = 'customers' AND entity_id = $2)
        OR (entity_type = 'opportunities' AND entity_id IN (SELECT id FROM opportunities WHERE customer_id = $2))
        OR (entity_type = 'complaints' AND entity_id IN (SELECT id FROM complaints WHERE customer_id = $2)))
     ORDER BY done ASC, due_at NULLS LAST, id DESC LIMIT 40`,
    [ctx.tenantId, customerId]
  );
  const complaints = await client.query(`SELECT id, complaint_no, subject, priority, status, opened_at FROM complaints WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`, [customerId]);
  const credit = await creditCheck(client, ctx, customerId);
  const agingRes = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN due_date IS NULL OR due_date >= CURRENT_DATE THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS current,
       COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 30 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_1_30,
       COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_31_60,
       COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_61_90,
       COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 90 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_90_plus
     FROM customer_invoices
     WHERE customer_id = $1 AND status NOT IN ('VOID','PAID')`,
    [customerId]
  );
  const plantRes = await client.query(
    `SELECT wo.id, wo.wo_no, wo.status, wo.quantity, wo.produced_qty, p.code AS product_code, p.name AS product_name
     FROM work_orders wo
     JOIN products p ON p.id = wo.product_id
     JOIN sales_orders so ON so.id = wo.sales_order_id
     WHERE wo.tenant_id = $1 AND so.customer_id = $2
       AND wo.status NOT IN ('CLOSED','CANCELLED')
     ORDER BY wo.id DESC
     LIMIT 12`,
    [ctx.tenantId, customerId]
  );

  const aging = {
    current: Number(agingRes.rows[0]?.current ?? 0),
    days130: Number(agingRes.rows[0]?.days_1_30 ?? 0),
    days3160: Number(agingRes.rows[0]?.days_31_60 ?? 0),
    days6190: Number(agingRes.rows[0]?.days_61_90 ?? 0),
    days90Plus: Number(agingRes.rows[0]?.days_90_plus ?? 0),
  };
  const overdueAr = aging.days130 + aging.days3160 + aging.days6190 + aging.days90Plus;
  const openComplaints = complaints.rows.filter((r) => ['OPEN', 'IN_PROGRESS', 'ESCALATED'].includes(String(r.status)));
  const criticalComplaints = openComplaints.filter((r) => ['HIGH', 'CRITICAL'].includes(String(r.priority)));
  const recentActivity = activities.rows.some((r) => {
    const stamp = r.completed_at || r.created_at;
    if (!stamp) return false;
    return Date.now() - new Date(String(stamp)).getTime() < 60 * 24 * 3600 * 1000;
  });
  const wonRecently = opps.rows.some((r) => String(r.status) === 'WON');
  const openOpps = opps.rows.filter((r) => String(r.status) === 'OPEN').length;
  const reasons: string[] = [];
  let score = 78;
  const status = String(res.rows[0].status);
  if (status === 'BLOCKED') {
    score = 0;
    reasons.push('Account is blocked');
  } else if (status === 'INACTIVE') {
    score = 22;
    reasons.push('Account is inactive');
  } else {
    if (!credit.ok) { score -= 25; reasons.push(credit.reason ?? 'Credit hold'); }
    if (aging.days90Plus > 0) { score -= 22; reasons.push('AR past 90 days'); }
    else if (aging.days6190 > 0) { score -= 14; reasons.push('AR 61–90 days'); }
    else if (aging.days3160 > 0) { score -= 8; reasons.push('AR 31–60 days'); }
    if (criticalComplaints.length) { score -= 18; reasons.push('High-priority complaint open'); }
    else if (openComplaints.length) { score -= 8; reasons.push('Open complaint'); }
    if (!recentActivity) { score -= 8; reasons.push('No activity in 60 days'); }
    if (openOpps > 0) score += 5;
    if (wonRecently) score += 8;
  }
  score = Math.max(0, Math.min(100, score));
  const health = { score, band: healthBand(score), reasons, overdueAr, openComplaints: openComplaints.length };

  const timeline = [
    ...activities.rows.map((r) => ({
      at: r.completed_at || r.due_at || r.created_at,
      kind: 'activity',
      label: String(r.subject),
      status: r.done ? 'DONE' : 'OPEN',
      ref: r.activity_type,
    })),
    ...quotes.rows.map((r) => ({
      at: r.quotation_date, kind: 'quotation', label: String(r.quotation_no), status: r.status, ref: r.id,
    })),
    ...orders.rows.map((r) => ({
      at: r.order_date, kind: 'order', label: String(r.order_no), status: r.status, ref: r.id,
    })),
    ...invoices.rows.map((r) => ({
      at: r.invoice_date || r.due_date, kind: 'invoice', label: String(r.invoice_no), status: r.status, ref: r.id,
    })),
    ...complaints.rows.map((r) => ({
      at: r.opened_at, kind: 'complaint', label: String(r.complaint_no), status: r.status, ref: r.id,
    })),
    ...opps.rows.map((r) => ({
      at: r.created_at || r.expected_close, kind: 'opportunity', label: String(r.name), status: r.status, ref: r.id,
    })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime())
    .slice(0, 40);

  return {
    customer: toCamelRow(res.rows[0]),
    contacts: toCamelRows(contacts.rows),
    opportunities: toCamelRows(opps.rows),
    quotations: toCamelRows(quotes.rows),
    orders: toCamelRows(orders.rows),
    invoices: toCamelRows(invoices.rows),
    activities: toCamelRows(activities.rows),
    complaints: toCamelRows(complaints.rows),
    plant: toCamelRows(plantRes.rows),
    credit,
    aging,
    health,
    timeline,
  };
}

export async function listLeads(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['l.tenant_id = $1', 'l.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(l.lead_no ILIKE $${params.length} OR l.company_name ILIKE $${params.length} OR l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.email ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`l.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT l.id, l.lead_no, l.first_name, l.last_name, l.company_name, l.email, l.phone,
            l.source, l.status, l.stage, l.value, l.converted_customer_id, l.assigned_to,
            COALESCE((l.attributes->>'score')::int, 0) AS score,
            TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS owner_name
     FROM leads l
     LEFT JOIN users u ON u.id = COALESCE(l.assigned_to, l.owner_user_id)
     WHERE ${where.join(' AND ')}
     ORDER BY l.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function getLead(client: pg.PoolClient, ctx: Ctx, leadId: number) {
  const res = await client.query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2`, [leadId, ctx.tenantId]);
  if (res.rows.length === 0) throw notFound('Lead not found');
  const activities = await client.query(
    `SELECT * FROM activities WHERE tenant_id = $1 AND entity_type = 'leads' AND entity_id = $2 ORDER BY id DESC`,
    [ctx.tenantId, leadId]
  );
  const opps = await client.query(`SELECT id, name, stage, status, amount FROM opportunities WHERE lead_id = $1`, [leadId]);
  return { lead: toCamelRow(res.rows[0]), activities: toCamelRows(activities.rows), opportunities: toCamelRows(opps.rows) };
}

export async function listOpportunities(client: pg.PoolClient, ctx: Ctx, filters: { status?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['o.tenant_id = $1', 'o.company_id = $2'];
  if (filters.status) {
    params.push(filters.status);
    where.push(`o.status = $${params.length}`);
  }
  const res = await client.query(
    `SELECT o.id, o.name, o.stage, o.status, o.amount, o.probability, o.expected_close, o.owner_user_id,
            c.id AS customer_id, c.code AS customer_code, c.name AS customer_name,
            TRIM(BOTH FROM COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS owner_name
     FROM opportunities o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users u ON u.id = o.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE o.stage
       WHEN 'NEGOTIATION' THEN 0 WHEN 'VALUE_PROPOSITION' THEN 1 WHEN 'NEEDS_ANALYSIS' THEN 2
       WHEN 'QUALIFICATION' THEN 3 WHEN 'PROSPECTING' THEN 4 WHEN 'WON' THEN 5 ELSE 6 END, o.id DESC`,
    params
  );
  return toCamelRows(res.rows);
}

export async function getOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number) {
  const res = await client.query(
    `SELECT o.*, c.code AS customer_code, c.name AS customer_name, c.status AS customer_status
     FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [opportunityId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Opportunity not found');
  const quotes = await client.query(
    `SELECT id, quotation_no, status, total, quotation_date FROM sales_quotations WHERE opportunity_id = $1 ORDER BY id DESC`,
    [opportunityId]
  );
  const activities = await client.query(
    `SELECT * FROM activities WHERE tenant_id = $1 AND entity_type = 'opportunities' AND entity_id = $2 ORDER BY id DESC`,
    [ctx.tenantId, opportunityId]
  );
  const credit = res.rows[0].customer_id
    ? await creditCheck(client, ctx, Number(res.rows[0].customer_id), Number(res.rows[0].amount) || 0)
    : null;
  return { opportunity: toCamelRow(res.rows[0]), quotations: toCamelRows(quotes.rows), activities: toCamelRows(activities.rows), credit };
}

export async function pipeline(client: pg.PoolClient, ctx: Ctx) {
  const rows = await listOpportunities(client, ctx, { status: 'OPEN' });
  const closed = await client.query(
    `SELECT o.id, o.name, o.stage, o.status, o.amount, c.name AS customer_name
     FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.tenant_id = $1 AND o.company_id = $2 AND o.status IN ('WON','LOST')
     ORDER BY o.id DESC LIMIT 20`,
    [ctx.tenantId, ctx.companyId]
  );
  const columns = PIPELINE_STAGES.filter((s) => s !== 'WON' && s !== 'LOST').map((stage) => ({
    stage,
    rows: rows.filter((r) => String(r.stage) === stage),
    total: rows.filter((r) => String(r.stage) === stage).reduce((s, r) => s + Number(r.amount || 0), 0),
  }));
  return { columns, closed: toCamelRows(closed.rows), weighted: rows.reduce((s, r) => s + Number(r.amount || 0) * (Number(r.probability || 0) / 100), 0) };
}

export async function listActivities(client: pg.PoolClient, ctx: Ctx, filters: { open?: boolean } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['a.tenant_id = $1', 'a.company_id = $2'];
  if (filters.open) where.push('a.done = false');
  const res = await client.query(
    `SELECT a.id, a.entity_type, a.entity_id, a.activity_type, a.subject, a.due_at, a.done, a.assigned_to,
            (a.done = false AND a.due_at IS NOT NULL AND a.due_at < now()) AS overdue
     FROM activities a WHERE ${where.join(' AND ')}
     ORDER BY a.done ASC, a.due_at NULLS LAST, a.id DESC
     LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listComplaints(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT cm.id, cm.complaint_no, cm.subject, cm.priority, cm.status, cm.opened_at,
            c.code AS customer_code, c.name AS customer_name, c.id AS customer_id
     FROM complaints cm JOIN customers c ON c.id = cm.customer_id
     WHERE cm.tenant_id = $1 AND cm.company_id = $2
     ORDER BY CASE cm.status WHEN 'ESCALATED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END, cm.id DESC
     LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getComplaint(client: pg.PoolClient, ctx: Ctx, complaintId: number) {
  const res = await client.query(
    `SELECT cm.*, c.code AS customer_code, c.name AS customer_name
     FROM complaints cm JOIN customers c ON c.id = cm.customer_id
     WHERE cm.id = $1 AND cm.tenant_id = $2`,
    [complaintId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Complaint not found');
  return { complaint: toCamelRow(res.rows[0]) };
}

export async function listSellableProducts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT p.id, p.code, p.name, p.type, p.standard_price, p.unit_id,
            COALESCE((
              SELECT sum(i.quantity - i.reserved_qty)
              FROM inventory i
              WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
            ), 0)::numeric AS available_qty
     FROM products p
     WHERE p.tenant_id = $1 AND p.company_id = $2 AND p.status = 'ACTIVE'
     ORDER BY p.code
     LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function crmBoard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM leads WHERE tenant_id = $1 AND company_id = $2 AND status IN ('NEW','CONTACTED','QUALIFIED'))::int AS open_leads,
       (SELECT count(*) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN')::int AS open_opps,
       (SELECT COALESCE(sum(amount),0) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN')::numeric AS pipeline,
       (SELECT COALESCE(sum(amount * probability / 100.0),0) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN')::numeric AS weighted,
       (SELECT count(*) FROM activities WHERE tenant_id = $1 AND company_id = $2 AND done = false AND due_at < now())::int AS overdue,
       (SELECT count(*) FROM complaints WHERE tenant_id = $1 AND company_id = $2 AND status IN ('OPEN','IN_PROGRESS','ESCALATED'))::int AS open_complaints,
       (SELECT count(*) FROM customers WHERE tenant_id = $1 AND company_id = $2 AND status = 'BLOCKED')::int AS blocked_accounts,
       (SELECT COALESCE(sum(total - amount_paid),0) FROM customer_invoices WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','PAID'))::numeric AS open_ar,
       (SELECT count(*) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'ON_HOLD')::int AS held_opps`,
    [ctx.tenantId, ctx.companyId]
  );
  const leads = await client.query(
    `SELECT id, lead_no, company_name, first_name, last_name, status, value
     FROM leads WHERE tenant_id = $1 AND company_id = $2 AND status IN ('NEW','CONTACTED','QUALIFIED')
     ORDER BY id DESC LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  const due = await client.query(
    `SELECT id, entity_type, entity_id, activity_type, subject, due_at, done
     FROM activities WHERE tenant_id = $1 AND company_id = $2 AND done = false
     ORDER BY due_at NULLS LAST, id DESC LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );
  const hot = await client.query(
    `SELECT o.id, o.name, o.stage, o.amount, o.probability, c.name AS customer_name
     FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.tenant_id = $1 AND o.company_id = $2 AND o.status = 'OPEN'
     ORDER BY o.probability DESC, o.amount DESC LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  const holds = await client.query(
    `SELECT id, code, name, status, credit_limit
     FROM customers WHERE tenant_id = $1 AND company_id = $2 AND status IN ('BLOCKED','INACTIVE')
     ORDER BY name LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    kpis: toCamelRow(kpis.rows[0]),
    leads: toCamelRows(leads.rows),
    due: toCamelRows(due.rows),
    hot: toCamelRows(hot.rows),
    holds: toCamelRows(holds.rows),
  };
}

export async function findDuplicates(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    excludeCustomerId?: number;
    excludeLeadId?: number;
  }
) {
  const name = (input.name ?? '').trim().toLowerCase();
  const email = (input.email ?? '').trim().toLowerCase();
  const phone = (input.phone ?? '').replace(/\D/g, '');
  if (!name && !email && phone.length < 7) return { customers: [], leads: [] };

  const custParams: unknown[] = [ctx.tenantId, ctx.companyId];
  const custOr: string[] = [];
  if (name.length >= 3) {
    custParams.push(`%${name}%`);
    custOr.push(`lower(c.name) LIKE $${custParams.length}`);
  }
  if (email) {
    custParams.push(email);
    custOr.push(`lower(COALESCE(c.email,'')) = $${custParams.length}`);
  }
  if (phone.length >= 7) {
    custParams.push(`%${phone.slice(-9)}%`);
    custOr.push(`regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE $${custParams.length}`);
  }
  const custWhere = ['c.tenant_id = $1', 'c.company_id = $2'];
  if (input.excludeCustomerId) {
    custParams.push(input.excludeCustomerId);
    custWhere.push(`c.id <> $${custParams.length}`);
  }
  const customers = custOr.length
    ? await client.query(
        `SELECT c.id, c.code, c.name, c.email, c.phone, c.status
         FROM customers c
         WHERE ${custWhere.join(' AND ')} AND (${custOr.join(' OR ')})
         ORDER BY c.name LIMIT 8`,
        custParams
      )
    : { rows: [] as Record<string, unknown>[] };

  const leadParams: unknown[] = [ctx.tenantId, ctx.companyId];
  const leadOr: string[] = [];
  if (name.length >= 3) {
    leadParams.push(`%${name}%`);
    leadOr.push(`(lower(COALESCE(l.company_name,'')) LIKE $${leadParams.length} OR lower(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) LIKE $${leadParams.length})`);
  }
  if (email) {
    leadParams.push(email);
    leadOr.push(`lower(COALESCE(l.email,'')) = $${leadParams.length}`);
  }
  if (phone.length >= 7) {
    leadParams.push(`%${phone.slice(-9)}%`);
    leadOr.push(`regexp_replace(COALESCE(l.phone,''), '\\D', '', 'g') LIKE $${leadParams.length}`);
  }
  const leadWhere = ['l.tenant_id = $1', 'l.company_id = $2', `l.status NOT IN ('DISQUALIFIED','LOST')`];
  if (input.excludeLeadId) {
    leadParams.push(input.excludeLeadId);
    leadWhere.push(`l.id <> $${leadParams.length}`);
  }
  const leads = leadOr.length
    ? await client.query(
        `SELECT l.id, l.lead_no, l.company_name, l.first_name, l.last_name, l.email, l.phone, l.status
         FROM leads l
         WHERE ${leadWhere.join(' AND ')} AND (${leadOr.join(' OR ')})
         ORDER BY l.id DESC LIMIT 8`,
        leadParams
      )
    : { rows: [] as Record<string, unknown>[] };

  return { customers: toCamelRows(customers.rows), leads: toCamelRows(leads.rows) };
}

export async function setCustomerStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  customerId: number,
  status: string,
  reason?: string | null,
  opts: { canBlock?: boolean } = {}
) {
  if (!CUSTOMER_STATUSES.includes(status as typeof CUSTOMER_STATUSES[number])) {
    throw badRequest('Unknown account status');
  }
  const cur = await client.query(
    `SELECT id, code, name, status FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [customerId, ctx.tenantId]
  );
  if (cur.rows.length === 0) throw notFound('Customer not found');
  const prev = String(cur.rows[0].status);
  if ((status === 'BLOCKED' || prev === 'BLOCKED') && !opts.canBlock) {
    throw forbidden('Missing permission: crm.customers.block');
  }
  if (prev === status) return { customerId, status, unchanged: true };
  await client.query(`UPDATE customers SET status = $2, updated_at = now() WHERE id = $1`, [customerId, status]);
  await emitEvent(client, ctx, {
    eventType: status === 'BLOCKED' ? 'crm.customer_blocked' : 'crm.customer_status',
    entityType: 'customers',
    entityId: customerId,
    entityCode: String(cur.rows[0].code),
    payload: { from: prev, to: status, reason: reason ?? null },
    severity: status === 'BLOCKED' ? 'WARN' : 'INFO',
  });
  await logAudit(client, ctx, {
    action: status === 'BLOCKED' ? 'block' : 'update',
    resource: 'customers',
    recordId: customerId,
    recordCode: String(cur.rows[0].code),
    oldValues: { status: prev },
    newValues: { status, reason: reason ?? null },
  });
  await logSystemActivity(client, ctx, {
    entityType: 'customers',
    entityId: customerId,
    activityType: 'NOTE',
    subject: `Status ${prev} → ${status}`,
    notes: reason ?? null,
  });
  return { customerId, status, previous: prev };
}

export async function assignOwner(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { entity: 'customers' | 'leads' | 'opportunities'; id: number; userId: number }
) {
  const owner = await client.query(
    `SELECT id, first_name, last_name FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [input.userId, ctx.tenantId]
  );
  if (owner.rows.length === 0) throw badRequest('Owner not found or not active');
  const ownerName = `${owner.rows[0].first_name} ${owner.rows[0].last_name}`.trim();
  if (input.entity === 'customers') {
    const res = await client.query(
      `UPDATE customers SET owner_user_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING code`,
      [input.id, ctx.tenantId, input.userId]
    );
    if (res.rows.length === 0) throw notFound('Customer not found');
    await logSystemActivity(client, ctx, {
      entityType: 'customers', entityId: input.id, activityType: 'NOTE', subject: `Assigned to ${ownerName}`,
    });
    return { entity: input.entity, id: input.id, userId: input.userId, ownerName };
  }
  if (input.entity === 'leads') {
    const res = await client.query(
      `UPDATE leads SET owner_user_id = $3, assigned_to = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING lead_no`,
      [input.id, ctx.tenantId, input.userId]
    );
    if (res.rows.length === 0) throw notFound('Lead not found');
    return { entity: input.entity, id: input.id, userId: input.userId, ownerName };
  }
  const res = await client.query(
    `UPDATE opportunities SET owner_user_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING name`,
    [input.id, ctx.tenantId, input.userId]
  );
  if (res.rows.length === 0) throw notFound('Opportunity not found');
  return { entity: input.entity, id: input.id, userId: input.userId, ownerName };
}

export async function contactLead(client: pg.PoolClient, ctx: Ctx, leadId: number, notes?: string | null) {
  const res = await client.query(
    `UPDATE leads SET status = 'CONTACTED', stage = 'CONTACTED', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status IN ('NEW','CONTACTED')
     RETURNING lead_no`,
    [leadId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Lead not found or already closed');
  await logSystemActivity(client, ctx, {
    entityType: 'leads',
    entityId: leadId,
    activityType: 'CALL',
    subject: 'Lead contacted',
    notes: notes ?? null,
  });
  return { leadId, leadNo: res.rows[0].lead_no, status: 'CONTACTED' };
}

export async function disqualifyLead(client: pg.PoolClient, ctx: Ctx, leadId: number, reason?: string | null) {
  const res = await client.query(
    `UPDATE leads
        SET status = 'DISQUALIFIED', stage = 'DISQUALIFIED',
            notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN notes ELSE TRIM(BOTH FROM COALESCE(notes,'') || E'\n' || $3::text) END,
            updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status IN ('NEW','CONTACTED','QUALIFIED')
     RETURNING lead_no`,
    [leadId, ctx.tenantId, reason ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Lead not found or cannot be disqualified');
  await emitEvent(client, ctx, {
    eventType: 'crm.lead_disqualified',
    entityType: 'leads',
    entityId: leadId,
    entityCode: String(res.rows[0].lead_no),
    payload: { reason: reason ?? null },
  });
  return { leadId, leadNo: res.rows[0].lead_no, status: 'DISQUALIFIED' };
}

export async function holdOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number, reason?: string | null) {
  const res = await client.query(
    `UPDATE opportunities
        SET status = 'ON_HOLD',
            notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN notes ELSE TRIM(BOTH FROM COALESCE(notes,'') || E'\n' || $3::text) END,
            updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'OPEN'
     RETURNING name`,
    [opportunityId, ctx.tenantId, reason ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Opportunity not found or not open');
  return { opportunityId, status: 'ON_HOLD' };
}

export async function resumeOpportunity(client: pg.PoolClient, ctx: Ctx, opportunityId: number) {
  const res = await client.query(
    `UPDATE opportunities SET status = 'OPEN', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'ON_HOLD'
     RETURNING name, stage`,
    [opportunityId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Opportunity not found or not on hold');
  return { opportunityId, status: 'OPEN', stage: res.rows[0].stage };
}

export async function listContacts(client: pg.PoolClient, ctx: Ctx, filters: { q?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['c.tenant_id = $1', 'c.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(ct.first_name ILIKE $${params.length} OR ct.last_name ILIKE $${params.length} OR ct.email ILIKE $${params.length} OR ct.phone ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT ct.id, ct.first_name, ct.last_name, ct.title, ct.email, ct.phone, ct.is_primary, ct.status,
            c.id AS customer_id, c.code AS customer_code, c.name AS customer_name
     FROM contacts ct
     JOIN customers c ON c.id = ct.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY ct.is_primary DESC, ct.last_name, ct.first_name
     LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listOwners(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.job_title
     FROM users u
     WHERE u.tenant_id = $1 AND u.status = 'ACTIVE'
       AND ($2::bigint IS NULL OR u.company_id = $2 OR u.company_id IS NULL)
     ORDER BY u.first_name, u.last_name
     LIMIT 80`,
    [ctx.tenantId, ctx.companyId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function myDesk(client: pg.PoolClient, ctx: Ctx) {
  const uid = ctx.userId ?? 0;
  const leads = await client.query(
      `SELECT l.id, l.lead_no, l.company_name, l.first_name, l.last_name, l.status, l.value,
              COALESCE((l.attributes->>'score')::int, 0) AS score
       FROM leads l
       WHERE l.tenant_id = $1 AND l.company_id = $2
         AND l.status IN ('NEW','CONTACTED','QUALIFIED')
         AND (l.assigned_to = $3 OR l.owner_user_id = $3)
       ORDER BY l.id DESC LIMIT 20`,
      [ctx.tenantId, ctx.companyId, uid]
    );
  const opps = await client.query(
      `SELECT o.id, o.name, o.stage, o.status, o.amount, o.probability, c.name AS customer_name
       FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.tenant_id = $1 AND o.company_id = $2 AND o.status IN ('OPEN','ON_HOLD') AND o.owner_user_id = $3
       ORDER BY o.probability DESC, o.amount DESC LIMIT 20`,
      [ctx.tenantId, ctx.companyId, uid]
    );
  const activities = await client.query(
      `SELECT id, entity_type, entity_id, activity_type, subject, due_at, done
       FROM activities
       WHERE tenant_id = $1 AND company_id = $2 AND done = false AND assigned_to = $3
       ORDER BY due_at NULLS LAST, id DESC LIMIT 20`,
      [ctx.tenantId, ctx.companyId, uid]
    );
  const complaints = await client.query(
      `SELECT cm.id, cm.complaint_no, cm.subject, cm.priority, cm.status, c.name AS customer_name
       FROM complaints cm JOIN customers c ON c.id = cm.customer_id
       WHERE cm.tenant_id = $1 AND cm.company_id = $2
         AND cm.status IN ('OPEN','IN_PROGRESS','ESCALATED') AND cm.assigned_to = $3
       ORDER BY cm.id DESC LIMIT 12`,
      [ctx.tenantId, ctx.companyId, uid]
    );
  return {
    leads: toCamelRows(leads.rows),
    opportunities: toCamelRows(opps.rows),
    activities: toCamelRows(activities.rows),
    complaints: toCamelRows(complaints.rows),
    kpis: {
      myLeads: leads.rows.length,
      myOpps: opps.rows.length,
      myFollowUps: activities.rows.length,
      myComplaints: complaints.rows.length,
    },
  };
}

export async function crmAnalytics(client: pg.PoolClient, ctx: Ctx) {
  const funnel = await client.query(
      `SELECT
         (SELECT count(*) FROM leads WHERE tenant_id = $1 AND company_id = $2)::int AS leads_total,
         (SELECT count(*) FROM leads WHERE tenant_id = $1 AND company_id = $2 AND status = 'QUALIFIED')::int AS leads_qualified,
         (SELECT count(*) FROM leads WHERE tenant_id = $1 AND company_id = $2 AND status = 'CONVERTED')::int AS leads_converted,
         (SELECT count(*) FROM leads WHERE tenant_id = $1 AND company_id = $2 AND status = 'DISQUALIFIED')::int AS leads_disqualified,
         (SELECT count(*) FROM opportunities WHERE tenant_id = $1 AND company_id = $2)::int AS opps_total,
         (SELECT count(*) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'WON')::int AS opps_won,
         (SELECT count(*) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'LOST')::int AS opps_lost,
         (SELECT COALESCE(sum(amount),0) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'WON')::numeric AS won_value,
         (SELECT COALESCE(sum(amount),0) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN')::numeric AS open_value,
         (SELECT COALESCE(sum(amount * probability / 100.0),0) FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN')::numeric AS weighted`,
      [ctx.tenantId, ctx.companyId]
    );
  const outcomes = await client.query(
      `SELECT stage, count(*)::int AS deals, COALESCE(sum(amount),0)::numeric AS amount
       FROM opportunities WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN'
       GROUP BY stage`,
      [ctx.tenantId, ctx.companyId]
    );
  const sources = await client.query(
      `SELECT source, count(*)::int AS leads,
              count(*) FILTER (WHERE status = 'CONVERTED')::int AS converted
       FROM leads WHERE tenant_id = $1 AND company_id = $2
       GROUP BY source ORDER BY leads DESC`,
      [ctx.tenantId, ctx.companyId]
    );
  const aging = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN due_date IS NULL OR due_date >= CURRENT_DATE THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS current,
         COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 30 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_1_30,
         COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_31_60,
         COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_61_90,
         COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 90 THEN GREATEST(total - amount_paid, 0) ELSE 0 END), 0)::numeric AS days_90_plus
       FROM customer_invoices
       WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','PAID')`,
      [ctx.tenantId, ctx.companyId]
    );
  const owners = await client.query(
      `SELECT COALESCE(u.id, 0) AS owner_id,
              COALESCE(TRIM(BOTH FROM u.first_name || ' ' || u.last_name), 'Unassigned') AS owner_name,
              count(*) FILTER (WHERE o.status = 'OPEN')::int AS open_deals,
              COALESCE(sum(o.amount) FILTER (WHERE o.status = 'OPEN'), 0)::numeric AS open_value,
              count(*) FILTER (WHERE o.status = 'WON')::int AS won_deals,
              COALESCE(sum(o.amount) FILTER (WHERE o.status = 'WON'), 0)::numeric AS won_value
       FROM opportunities o
       LEFT JOIN users u ON u.id = o.owner_user_id
       WHERE o.tenant_id = $1 AND o.company_id = $2
       GROUP BY u.id, u.first_name, u.last_name
       ORDER BY won_value DESC, open_value DESC
       LIMIT 12`,
      [ctx.tenantId, ctx.companyId]
    );
  const forecast = await client.query(
      `SELECT
         COALESCE(sum(amount * probability / 100.0) FILTER (
           WHERE expected_close IS NULL OR (expected_close >= date_trunc('month', CURRENT_DATE)
             AND expected_close < date_trunc('month', CURRENT_DATE) + interval '1 month')
         ), 0)::numeric AS this_month,
         COALESCE(sum(amount * probability / 100.0) FILTER (
           WHERE expected_close >= date_trunc('month', CURRENT_DATE) + interval '1 month'
             AND expected_close < date_trunc('month', CURRENT_DATE) + interval '2 month'
         ), 0)::numeric AS next_month,
         COALESCE(sum(amount * probability / 100.0), 0)::numeric AS weighted
       FROM opportunities
       WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN'`,
      [ctx.tenantId, ctx.companyId]
    );
  const f = funnel.rows[0];
  const leadsTotal = Number(f.leads_total) || 0;
  const oppsClosed = Number(f.opps_won) + Number(f.opps_lost);
  return {
    funnel: toCamelRow(f),
    conversionRate: leadsTotal > 0 ? Math.round((Number(f.leads_converted) / leadsTotal) * 1000) / 10 : 0,
    winRate: oppsClosed > 0 ? Math.round((Number(f.opps_won) / oppsClosed) * 1000) / 10 : 0,
    stages: toCamelRows(outcomes.rows),
    sources: toCamelRows(sources.rows),
    aging: {
      current: Number(aging.rows[0]?.current ?? 0),
      days130: Number(aging.rows[0]?.days_1_30 ?? 0),
      days3160: Number(aging.rows[0]?.days_31_60 ?? 0),
      days6190: Number(aging.rows[0]?.days_61_90 ?? 0),
      days90Plus: Number(aging.rows[0]?.days_90_plus ?? 0),
    },
    owners: toCamelRows(owners.rows),
    forecast: toCamelRow(forecast.rows[0]),
  };
}
