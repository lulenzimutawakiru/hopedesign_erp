/**
 * Company records that operate the ISO controls. The assessment in register.ts
 * is not writable from here. These rows are the evidence a control points at.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';

const KINDS = [
  'ISMS_POLICY', 'ACCEPTABLE_USE', 'AWARENESS', 'OPERATING_PROCEDURE',
  'INCIDENT_PLAN', 'SECURE_DEVELOPMENT', 'SECURE_CODING', 'ARCHITECTURE',
  'SECURITY_REQUIREMENTS', 'TEST_DATA', 'AUDIT_TESTING', 'REMOTE_WORK',
  'CLEAR_DESK', 'NETWORK', 'CLOUD_RESPONSIBILITY',
] as const;

const STATUSES = ['OPEN', 'CURRENT', 'CLOSED', 'REJECTED'] as const;

type Payload = Record<string, unknown>;

function str(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function companyId(ctx: Ctx): number {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

function rethrowRule(err: unknown): never {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === '23514') throw badRequest('This record does not satisfy the ISO operating rules.');
  throw err;
}

function asPayload(value: unknown): Payload {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('payload must be an object');
  return value as Payload;
}

function requireText(payload: Payload, key: string): void {
  if (!str(payload[key])) throw badRequest(`${key} is required`);
}

function requireTrue(payload: Payload, key: string): void {
  if (payload[key] !== true && payload[key] !== 'true') throw badRequest(`${key} must be true`);
}

/** Rules that apply once a record leaves the open state. */
function assertPayload(entryType: string, status: string, payload: Payload, reviewedOn: string | null): void {
  if (status === 'OPEN' || status === 'REJECTED') return;
  switch (entryType) {
    case 'objective':
      if (!reviewedOn) throw badRequest('reviewedOn is required');
      requireText(payload, 'reviewer');
      break;
    case 'authority_contact':
      requireText(payload, 'body');
      requireText(payload, 'channel');
      break;
    case 'interest_group':
      requireText(payload, 'body');
      break;
    case 'threat_advisory':
      if (status === 'CLOSED') {
        if (!['APPLIES', 'DOES_NOT_APPLY'].includes(String(payload.applicability))) {
          throw badRequest('applicability must be APPLIES or DOES_NOT_APPLY');
        }
        requireText(payload, 'decision');
      }
      break;
    case 'information_asset':
      requireText(payload, 'store');
      if (!['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(String(payload.classification))) {
        throw badRequest('classification must be PUBLIC, INTERNAL, CONFIDENTIAL or RESTRICTED');
      }
      break;
    case 'transfer_agreement':
      requireText(payload, 'counterparty');
      requireText(payload, 'channel');
      break;
    case 'access_review':
      if (status === 'CLOSED') {
        if (!Number.isFinite(Number(payload.grantsReviewed))) throw badRequest('grantsReviewed is required');
        if (!Number.isFinite(Number(payload.revoked))) throw badRequest('revoked is required');
      }
      break;
    case 'supplier_review':
      if (!['APPROVED', 'REJECTED'].includes(String(payload.result))) {
        throw badRequest('result must be APPROVED or REJECTED');
      }
      break;
    case 'supplier_clause':
      requireText(payload, 'clause');
      break;
    case 'supplier_service_review':
      requireText(payload, 'service');
      requireText(payload, 'reviewedOn');
      break;
    case 'security_event':
      if (status === 'CLOSED') {
        if (!['INCIDENT', 'NOT_AN_INCIDENT'].includes(String(payload.decision))) {
          throw badRequest('decision must be INCIDENT or NOT_AN_INCIDENT');
        }
        requireText(payload, 'decidedBy');
      }
      break;
    case 'incident':
      requireText(payload, 'containment');
      if (status === 'CLOSED') requireText(payload, 'lessonId');
      break;
    case 'lesson':
      requireText(payload, 'actionOwner');
      if (status === 'CLOSED') requireTrue(payload, 'actionDone');
      break;
    case 'continuity':
      if (!Number.isFinite(Number(payload.rpoHours)) || !Number.isFinite(Number(payload.rtoHours))) {
        throw badRequest('rpoHours and rtoHours are required');
      }
      requireTrue(payload, 'controlsHeld');
      requireText(payload, 'signedBy');
      break;
    case 'licence':
      requireText(payload, 'name');
      requireText(payload, 'licence');
      break;
    case 'independent_review':
      requireText(payload, 'reviewer');
      requireTrue(payload, 'external');
      requireText(payload, 'nextReviewOn');
      break;
    case 'screening':
      if (!['CLEAR', 'ADVERSE'].includes(String(payload.outcome))) {
        throw badRequest('outcome must be CLEAR or ADVERSE');
      }
      break;
    case 'quality_plan':
      requireText(payload, 'criteria');
      break;
    case 'project_gate':
      if (!['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(String(payload.decision))) {
        throw badRequest('decision must be PASS, FAIL or NOT_APPLICABLE');
      }
      break;
    case 'measurement_plan':
      requireText(payload, 'measure');
      requireText(payload, 'frequency');
      break;
    case 'requirement_review':
      requireTrue(payload, 'accepted');
      break;
    case 'deletion_proof':
      if (!Number.isFinite(Number(payload.subjectRequestId))) throw badRequest('subjectRequestId is required');
      requireTrue(payload, 'backupsWiped');
      requireTrue(payload, 'filesWiped');
      break;
    case 'preservation_limit':
      if (!Number.isFinite(Number(payload.min)) || !Number.isFinite(Number(payload.max))) {
        throw badRequest('min and max are required');
      }
      requireText(payload, 'unit');
      break;
    case 'preservation_reading':
      if (!Number.isFinite(Number(payload.value))) throw badRequest('value is required');
      break;
    case 'audit_finding':
      requireText(payload, 'finding');
      if (status === 'CLOSED') {
        requireText(payload, 'correctiveAction');
        requireTrue(payload, 'verified');
      }
      break;
    case 'improvement':
      requireText(payload, 'opportunity');
      if (status === 'CLOSED') {
        requireText(payload, 'decision');
        requireTrue(payload, 'resultChecked');
      }
      break;
    case 'capacity':
      requireText(payload, 'threshold');
      requireText(payload, 'loadTestOn');
      break;
    case 'outsourced_development':
      requireText(payload, 'supplier');
      requireText(payload, 'terms');
      break;
    case 'customer_property':
      requireText(payload, 'customer');
      requireText(payload, 'item');
      if (!['SOUND', 'LOST', 'DAMAGED', 'UNSUITABLE'].includes(String(payload.condition))) {
        throw badRequest('condition must be SOUND, LOST, DAMAGED or UNSUITABLE');
      }
      requireText(payload, 'report');
      break;
    case 'disposal_certificate':
      requireText(payload, 'method');
      requireTrue(payload, 'wiped');
      break;
    case 'maintenance_release':
      requireText(payload, 'releasedBy');
      break;
    case 'vulnerability':
      if (status === 'CLOSED') requireText(payload, 'patchedOn');
      break;
    case 'post_delivery':
      requireText(payload, 'followUp');
      break;
    case 'internal_audit':
      requireText(payload, 'programme');
      break;
    default:
      break;
  }
}

async function assertPolicyReview(client: pg.PoolClient, ctx: Ctx, entryType: string, status: string): Promise<void> {
  if (entryType !== 'policy_review' || (status !== 'CURRENT' && status !== 'CLOSED')) return;
  const overdue = await client.query(
    `SELECT code FROM iso_policies
      WHERE company_id = $1 AND status = 'APPROVED' AND next_review_on < CURRENT_DATE
      LIMIT 1`,
    [companyId(ctx)],
  );
  if (overdue.rows.length > 0) {
    throw badRequest(`Policy ${overdue.rows[0].code} is past its review date.`);
  }
}

async function assertIncidentPlan(client: pg.PoolClient, ctx: Ctx, entryType: string, status: string): Promise<void> {
  if (entryType !== 'incident' || (status !== 'CURRENT' && status !== 'CLOSED')) return;
  const plan = await client.query(
    `SELECT 1 FROM iso_policies
      WHERE company_id = $1 AND kind = 'INCIDENT_PLAN' AND status = 'APPROVED'
        AND next_review_on >= CURRENT_DATE
      LIMIT 1`,
    [companyId(ctx)],
  );
  if (plan.rows.length === 0) {
    throw badRequest('An incident cannot be opened until an approved incident plan is in force.');
  }
}

export async function listPolicies(client: pg.PoolClient, ctx: Ctx, kind?: string) {
  const params: unknown[] = [companyId(ctx)];
  let where = 'company_id = $1';
  if (kind) {
    params.push(kind);
    where += ` AND kind = $${params.length}`;
  }
  const res = await client.query(
    `SELECT * FROM iso_policies WHERE ${where} ORDER BY kind, code, version`,
    params,
  );
  return toCamelRows(res.rows as Record<string, unknown>[]);
}

export async function createPolicy(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    code?: string | null;
    kind: string;
    title: string;
    version: string;
    body: string;
    ownerRole: string;
    nextReviewOn?: string | null;
    subjectUserId?: number | null;
  },
) {
  const kind = String(input.kind ?? '').toUpperCase();
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw badRequest('Unknown policy kind');
  const title = str(input.title);
  const version = str(input.version);
  const body = str(input.body);
  const ownerRole = str(input.ownerRole);
  if (!title || !version || !body || !ownerRole) throw badRequest('title, version, body and ownerRole are required');
  const code = str(input.code) ?? `${kind}-${version}`;
  const res = await client.query(
    `INSERT INTO iso_policies
       (company_id, tenant_id, code, kind, title, version, body, owner_role, next_review_on, subject_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      companyId(ctx), ctx.tenantId, code, kind, title, version, body, ownerRole,
      str(input.nextReviewOn), input.subjectUserId ?? null, ctx.userId ?? null,
    ],
  );
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: 'create', resource: 'iso_policies', recordId: Number(row.id), recordCode: String(row.code),
    newValues: { kind, version },
  });
  return toCamelRow(row as Record<string, unknown>);
}

export async function approvePolicy(client: pg.PoolClient, ctx: Ctx, policyId: number, nextReviewOn?: string | null) {
  const current = await client.query(
    `SELECT * FROM iso_policies WHERE id = $1 AND company_id = $2`,
    [policyId, companyId(ctx)],
  );
  if (current.rows.length === 0) throw notFound('Policy not found');
  const row = current.rows[0];
  if (row.status !== 'DRAFT') throw badRequest('Only a draft policy can be approved');
  if (ctx.userId != null && Number(row.created_by) === ctx.userId) {
    throw badRequest('The author of a policy cannot approve it.');
  }
  const review = str(nextReviewOn) ?? (row.next_review_on ? String(row.next_review_on).slice(0, 10) : null);
  if (!review) throw badRequest('nextReviewOn is required');
  const res = await client.query(
    `UPDATE iso_policies
        SET status = 'APPROVED', approved_by = $3, approved_at = now(), next_review_on = $4
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [policyId, companyId(ctx), ctx.userId ?? null, review],
  );
  await logAudit(client, ctx, {
    action: 'approve', resource: 'iso_policies', recordId: policyId, recordCode: String(row.code),
    newValues: { status: 'APPROVED', nextReviewOn: review },
  });
  return toCamelRow(res.rows[0] as Record<string, unknown>);
}

export async function retirePolicy(client: pg.PoolClient, ctx: Ctx, policyId: number) {
  const res = await client.query(
    `UPDATE iso_policies SET status = 'RETIRED'
      WHERE id = $1 AND company_id = $2 AND status = 'APPROVED'
      RETURNING *`,
    [policyId, companyId(ctx)],
  );
  if (res.rows.length === 0) throw badRequest('Policy not found or not approved');
  return toCamelRow(res.rows[0] as Record<string, unknown>);
}

export async function acknowledgePolicy(client: pg.PoolClient, ctx: Ctx, policyId: number) {
  if (!ctx.userId) throw badRequest('A user is required');
  const policy = await client.query(
    `SELECT * FROM iso_policies WHERE id = $1 AND company_id = $2 AND status = 'APPROVED'`,
    [policyId, companyId(ctx)],
  );
  if (policy.rows.length === 0) throw notFound('Approved policy not found');
  const row = policy.rows[0];
  if (row.subject_user_id != null && Number(row.subject_user_id) !== ctx.userId) {
    throw badRequest('This policy is addressed to someone else.');
  }
  const res = await client.query(
    `INSERT INTO iso_acknowledgements (company_id, tenant_id, user_id, policy_id, policy_version)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, policy_id, policy_version) DO UPDATE SET acknowledged_at = now()
     RETURNING *`,
    [companyId(ctx), ctx.tenantId, ctx.userId, policyId, row.version],
  );
  return toCamelRow(res.rows[0] as Record<string, unknown>);
}

export async function listEntries(
  client: pg.PoolClient,
  ctx: Ctx,
  filter: { entryType?: string; status?: string; limit?: number } = {},
) {
  const params: unknown[] = [companyId(ctx)];
  const where = ['company_id = $1'];
  if (filter.entryType) {
    params.push(filter.entryType);
    where.push(`entry_type = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  params.push(limit);
  const res = await client.query(
    `SELECT * FROM iso_entries WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return toCamelRows(res.rows as Record<string, unknown>[]);
}

export async function createEntry(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    entryType: string;
    status?: string | null;
    title: string;
    ownerRole: string;
    subjectTable?: string | null;
    subjectId?: number | null;
    dueOn?: string | null;
    reviewedOn?: string | null;
    payload?: unknown;
  },
) {
  const entryType = String(input.entryType ?? '').toLowerCase();
  const status = String(input.status ?? 'OPEN').toUpperCase();
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw badRequest('Invalid status');
  const title = str(input.title);
  const ownerRole = str(input.ownerRole);
  if (!title || !ownerRole) throw badRequest('title and ownerRole are required');
  const payload = asPayload(input.payload);
  const reviewedOn = str(input.reviewedOn);
  assertPayload(entryType, status, payload, reviewedOn);
  await assertPolicyReview(client, ctx, entryType, status);
  await assertIncidentPlan(client, ctx, entryType, status);
  let res;
  try {
    res = await client.query(
      `INSERT INTO iso_entries
         (company_id, tenant_id, entry_type, status, title, owner_role, subject_table, subject_id,
          due_on, reviewed_on, closed_on, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $4 IN ('CLOSED','REJECTED') THEN CURRENT_DATE ELSE NULL END, $11, $12)
       RETURNING *`,
      [
        companyId(ctx), ctx.tenantId, entryType, status, title, ownerRole,
        str(input.subjectTable), input.subjectId ?? null, str(input.dueOn), reviewedOn,
        JSON.stringify(payload), ctx.userId ?? null,
      ],
    );
  } catch (err) {
    rethrowRule(err);
  }
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: 'create', resource: 'iso_entries', recordId: Number(row.id),
    newValues: { entryType, status, title },
  });
  return toCamelRow(row as Record<string, unknown>);
}

export async function updateEntry(
  client: pg.PoolClient,
  ctx: Ctx,
  entryId: number,
  input: { status?: string | null; payload?: unknown; reviewedOn?: string | null; title?: string | null },
) {
  const current = await client.query(
    `SELECT * FROM iso_entries WHERE id = $1 AND company_id = $2`,
    [entryId, companyId(ctx)],
  );
  if (current.rows.length === 0) throw notFound('Record not found');
  const row = current.rows[0];
  const status = input.status ? String(input.status).toUpperCase() : String(row.status);
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw badRequest('Invalid status');
  const payload = input.payload === undefined ? (row.payload as Payload) : { ...(row.payload as Payload), ...asPayload(input.payload) };
  const reviewedOn = input.reviewedOn === undefined
    ? (row.reviewed_on ? String(row.reviewed_on).slice(0, 10) : null)
    : str(input.reviewedOn);
  assertPayload(String(row.entry_type), status, payload, reviewedOn);
  await assertPolicyReview(client, ctx, String(row.entry_type), status);
  await assertIncidentPlan(client, ctx, String(row.entry_type), status);
  let res;
  try {
    res = await client.query(
      `UPDATE iso_entries
          SET status = $3, payload = $4, reviewed_on = $5,
              title = COALESCE($6, title),
              closed_on = CASE WHEN $3 IN ('CLOSED','REJECTED') THEN CURRENT_DATE ELSE closed_on END
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [entryId, companyId(ctx), status, JSON.stringify(payload), reviewedOn, str(input.title)],
    );
  } catch (err) {
    rethrowRule(err);
  }
  return toCamelRow(res.rows[0] as Record<string, unknown>);
}

/** Approve a supplier for purchasing once the review and the security clause are current. */
export async function approveSupplier(client: pg.PoolClient, ctx: Ctx, supplierId: number) {
  const supplier = await client.query(
    `SELECT id, code FROM suppliers WHERE id = $1 AND tenant_id = $2`,
    [supplierId, ctx.tenantId],
  );
  if (supplier.rows.length === 0) throw notFound('Supplier not found');
  const review = await client.query(
    `SELECT 1 FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'supplier_review' AND status = 'CURRENT'
        AND subject_table = 'suppliers' AND subject_id = $2
        AND payload->>'result' = 'APPROVED'
      LIMIT 1`,
    [ctx.tenantId, supplierId],
  );
  const clause = await client.query(
    `SELECT 1 FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'supplier_clause' AND status = 'CURRENT'
        AND subject_table = 'suppliers' AND subject_id = $2
      LIMIT 1`,
    [ctx.tenantId, supplierId],
  );
  if (review.rows.length === 0 || clause.rows.length === 0) {
    throw badRequest('A current security review and a security clause are required before this supplier can be approved.');
  }
  await client.query(
    `UPDATE suppliers
        SET iso_review_status = 'APPROVED', iso_review_due = CURRENT_DATE + 365, status = 'ACTIVE'
      WHERE id = $1`,
    [supplierId],
  );
  return { supplierId, code: String(supplier.rows[0].code), isoReviewStatus: 'APPROVED' };
}
