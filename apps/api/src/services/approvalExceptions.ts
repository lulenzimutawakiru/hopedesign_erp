import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, forbidden, notFound } from '../utils.js';
import { toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import { notifyUsers } from './communication.js';

/**
 * Controlled approval exceptions (prompt Phase 6).
 *
 * A deviation from a mandatory approval/SoD rule is a *recorded, authorised,
 * time-boxed* decision - never a silent override. This module is a ledger and
 * lifecycle for those deviations. It deliberately does NOT wire any bypass
 * into decideTask: self-approval and segregation-of-duties checks in
 * workflow.ts remain mandatory, and a blocked transaction stays blocked until
 * either an independent approver is configured or a fully-approved exception
 * with a compensating control and an independent subsequent reviewer exists.
 */

const EDITABLE = new Set(['REQUESTED']);

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function reqStr(body: Record<string, unknown>, key: string): string {
  const v = str(body[key]);
  if (v === null || v.trim().length === 0) throw badRequest(key + ' is required');
  return v.trim();
}

async function getException(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  forUpdate = false
): Promise<Record<string, unknown>> {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query(
    'SELECT * FROM approval_exceptions WHERE id = $1 AND tenant_id = $2' + lock,
    [id, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Approval exception not found');
  return rows[0];
}

async function audit(
  client: pg.PoolClient,
  ctx: Ctx,
  entry: {
    action: string; recordId: number; recordCode?: string | null;
    oldValues?: Record<string, unknown>; newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await logAudit(client, ctx, {
    action: entry.action,
    resource: 'approval_exception',
    recordId: entry.recordId,
    recordCode: entry.recordCode ?? null,
    oldValues: entry.oldValues ?? null,
    newValues: entry.newValues ?? null,
    metadata: entry.metadata ?? {},
  });
}

async function notify(
  client: pg.PoolClient,
  ctx: Ctx,
  userIds: number[],
  input: { title: string; body: string; link: string }
): Promise<void> {
  const ids = userIds.filter((n) => Number.isFinite(n) && n > 0 && n !== ctx.userId);
  if (ids.length === 0) return;
  await notifyUsers(
    client,
    ctx,
    {
      type: 'APPROVAL_EXCEPTION',
      title: input.title,
      body: input.body,
      link: input.link,
      severity: 'INFO',
      priority: 'NORMAL',
      actionLabel: 'Review',
      actionTarget: input.link,
      channels: ['IN_APP'],
      data: {},
    },
    ids
  );
}

function expiryFlags(row: Record<string, unknown>): { is_expired: boolean; review_overdue: boolean } {
  const status = String(row.status);
  const expiresAt = str(row.expires_at) ?? str(row.expiresAt);
  const deadline = str(row.review_deadline) ?? str(row.reviewDeadline);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isExpired =
    status === 'APPROVED' && expiresAt != null && new Date(expiresAt + 'T00:00:00').getTime() < today.getTime();
  const reviewOverdue =
    status === 'APPROVED' && deadline != null && new Date(deadline + 'T00:00:00').getTime() < today.getTime();
  return { is_expired: isExpired, review_overdue: reviewOverdue };
}

const EXCEPTION_JOIN =
  ' req.first_name AS requester_first_name, req.last_name AS requester_last_name,' +
  ' appr.first_name AS approver_first_name, appr.last_name AS approver_last_name,' +
  ' rev.first_name AS reviewer_first_name, rev.last_name AS reviewer_last_name' +
  ' FROM approval_exceptions e' +
  ' LEFT JOIN users req ON req.id = e.requested_by' +
  ' LEFT JOIN users appr ON appr.id = e.approved_by' +
  ' LEFT JOIN users rev ON rev.id = e.independent_reviewer';

export async function listApprovalExceptions(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { status?: string | null; entityType?: string | null; entityId?: number | null } = {}
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [ctx.tenantId];
  const conds = ['e.tenant_id = $1'];
  let i = 2;
  if (opts.status) { conds.push('e.status = $' + i); params.push(opts.status); i += 1; }
  if (opts.entityType) { conds.push('e.entity_type = $' + i); params.push(opts.entityType); i += 1; }
  if (opts.entityId != null) { conds.push('e.entity_id = $' + i); params.push(opts.entityId); i += 1; }
  if (ctx.companyId) { conds.push('e.company_id = $' + i); params.push(ctx.companyId); i += 1; }
  const { rows } = await client.query(
    'SELECT e.*,' + EXCEPTION_JOIN +
      ' WHERE ' + conds.join(' AND ') + ' ORDER BY e.id DESC LIMIT 200',
    params
  );
  return rows.map((r) => ({ ...toCamelRow(r), ...expiryFlags(r) }));
}

export async function getApprovalExceptionDetail(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<Record<string, unknown>> {
  const e = await getException(client, ctx, id);
  const { rows } = await client.query(
    'SELECT e.*,' + EXCEPTION_JOIN + ' WHERE e.id = $1 AND e.tenant_id = $2',
    [id, ctx.tenantId]
  );
  return { ...toCamelRow(rows[0]), ...expiryFlags(rows[0]) };
}

export async function createApprovalException(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const entityType = reqStr(body, 'entityType');
  const entityId = num(body.entityId);
  if (!entityId || entityId <= 0) throw badRequest('entityId is required');
  const deviation = reqStr(body, 'deviation');
  const justification = reqStr(body, 'justification');
  // The compensating control, scope, expiry and independent reviewer are the
  // control package that makes a deviation acceptable; they may be completed
  // later but are mandatory before authorisation (see approve).
  const entityCode = str(body.entityCode) ?? null;
  const scope = str(body.scope) ?? null;
  const compensatingControl = str(body.compensatingControl) ?? null;
  const expiresAt = str(body.expiresAt) ?? null;
  const reviewDeadline = str(body.reviewDeadline) ?? null;
  const independentReviewerId = num(body.independentReviewerId);

  if (independentReviewerId && independentReviewerId === ctx.userId) {
    throw badRequest('The independent reviewer must be a different user from the requester');
  }

  const { rows } = await client.query(
    `INSERT INTO approval_exceptions
       (tenant_id, company_id, entity_type, entity_id, entity_code, deviation,
        justification, scope, compensating_control, expires_at, review_deadline,
        independent_reviewer, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'REQUESTED')
     RETURNING *`,
    [
      ctx.tenantId,
      ctx.companyId ?? null,
      entityType,
      entityId,
      entityCode,
      deviation,
      justification,
      scope,
      compensatingControl,
      expiresAt,
      reviewDeadline,
      independentReviewerId,
      ctx.userId ?? null,
    ]
  );
  const created = rows[0];
  await audit(client, ctx, {
    action: 'exception.requested',
    recordId: Number(created.id),
    newValues: toCamelRow(created),
    metadata: { entityType, entityId },
  });
  return toCamelRow(created);
}

/** Full control package required before a deviation may be authorised. */
function requireControlPackage(row: Record<string, unknown>): void {
  const missing: string[] = [];
  if (str(row.scope) == null || String(row.scope).trim() === '') missing.push('scope');
  if (str(row.compensating_control) == null || String(row.compensating_control).trim() === '') {
    missing.push('compensatingControl');
  }
  if (str(row.expires_at) == null) missing.push('expiresAt');
  if (row.independent_reviewer == null) missing.push('independentReviewerId');
  if (str(row.review_deadline) == null) missing.push('reviewDeadline');
  if (missing.length > 0) {
    throw badRequest(
      'Exception is missing its control package before authorisation: ' + missing.join(', ')
    );
  }
}

export async function approveApprovalException(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason: string | null
): Promise<Record<string, unknown>> {
  if (!reason) throw badRequest('A reason is required to authorise an exception');
  const e = await getException(client, ctx, id, true);
  if (String(e.status) !== 'REQUESTED') {
    throw badRequest('Exception must be REQUESTED (current: ' + e.status + ')');
  }
  if (Number(e.requested_by) === ctx.userId) {
    throw forbidden('You cannot authorise your own exception');
  }
  requireControlPackage(e);
  const { rows } = await client.query(
    `UPDATE approval_exceptions
       SET status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, ctx.userId ?? null]
  );
  const updated = rows[0];
  await audit(client, ctx, {
    action: 'exception.approved',
    recordId: id,
    oldValues: { status: 'REQUESTED' },
    newValues: toCamelRow(updated),
    metadata: { reason },
  });
  await notify(client, ctx, [Number(updated.requested_by)], {
    title: 'Approval exception authorised',
    body: 'Your controlled exception on ' + String(updated.entity_type) + ' #' + String(updated.entity_id) + ' was authorised.',
    link: '/approval-exceptions/' + id,
  });
  await notify(client, ctx, [Number(updated.independent_reviewer)], {
    title: 'Independent review requested',
    body: 'You have been designated the independent reviewer for an approval exception.',
    link: '/approval-exceptions/' + id,
  });
  return toCamelRow(updated);
}

export async function rejectApprovalException(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason: string | null
): Promise<Record<string, unknown>> {
  if (!reason) throw badRequest('A reason is required to refuse an exception');
  const e = await getException(client, ctx, id, true);
  if (String(e.status) !== 'REQUESTED') {
    throw badRequest('Exception must be REQUESTED (current: ' + e.status + ')');
  }
  const { rows } = await client.query(
    `UPDATE approval_exceptions
       SET status = 'REJECTED', updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  const updated = rows[0];
  await audit(client, ctx, {
    action: 'exception.rejected',
    recordId: id,
    oldValues: { status: 'REQUESTED' },
    newValues: toCamelRow(updated),
    metadata: { reason },
  });
  await notify(client, ctx, [Number(updated.requested_by)], {
    title: 'Approval exception refused',
    body: 'Your controlled exception on ' + String(updated.entity_type) + ' #' + String(updated.entity_id) + ' was refused.',
    link: '/approval-exceptions/' + id,
  });
  return toCamelRow(updated);
}

export async function resolveApprovalException(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  outcome: string | null,
  reason: string | null
): Promise<Record<string, unknown>> {
  if (!outcome) throw badRequest('reviewOutcome is required');
  const e = await getException(client, ctx, id, true);
  if (String(e.status) !== 'APPROVED') {
    throw badRequest('Only an APPROVED exception can be reviewed (current: ' + e.status + ')');
  }
  // The designated independent reviewer records the outcome; a governance
  // administrator may stand in. The route already gates the latter on the
  // workflows.exceptions.resolve permission.
  if (Number(e.independent_reviewer) !== ctx.userId) {
    throw forbidden('Only the designated independent reviewer can record the review outcome');
  }
  const { rows } = await client.query(
    `UPDATE approval_exceptions
       SET status = 'REVIEWED', review_outcome = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, outcome]
  );
  const updated = rows[0];
  await audit(client, ctx, {
    action: 'exception.reviewed',
    recordId: id,
    oldValues: { status: 'APPROVED', review_outcome: null },
    newValues: toCamelRow(updated),
    metadata: { reason: reason ?? null },
  });
  return toCamelRow(updated);
}

export async function expireApprovalException(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason: string | null
): Promise<Record<string, unknown>> {
  const e = await getException(client, ctx, id, true);
  if (String(e.status) !== 'APPROVED' && String(e.status) !== 'REQUESTED') {
    throw badRequest('Only a REQUESTED or APPROVED exception can be expired (current: ' + e.status + ')');
  }
  const { rows } = await client.query(
    `UPDATE approval_exceptions
       SET status = 'EXPIRED', updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  const updated = rows[0];
  await audit(client, ctx, {
    action: 'exception.expired',
    recordId: id,
    oldValues: { status: e.status },
    newValues: toCamelRow(updated),
    metadata: { reason: reason ?? null },
  });
  return toCamelRow(updated);
}
