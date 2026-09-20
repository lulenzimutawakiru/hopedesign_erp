import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils.js';
import { auditComms, notifyUsers } from '../communication.js';
import { usersWithPermission } from '../serviceDeskCommon.js';
import { loadClassification } from './policy.js';
import { sendStoredEmail, type SendStoredEmailResult } from './send.js';

/**
 * Mail approval ledger.
 *
 * Approval before sending is a control, not a workflow nicety: a message whose
 * classification requires approval must not reach the wire until an authorised
 * second person has released it. That release path is `sendStoredEmail`'s
 * `release` option, whose preconditions are re-verified against
 * `email_approvals` inside the same transaction - so no route can skip the
 * control by calling a different endpoint.
 *
 * This module deliberately does NOT ride `services/workflow.ts`. `startWorkflow`
 * auto-approves when a document type has no configured chain, which would
 * silently defeat the classification gate, and `emails` is not a workflow
 * entity. Bridging mail into `approval_workflows` for configurable multi-level
 * chains is a backend requirement, tracked separately.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED';

/**
 * Why a visible pending approval cannot be decided by the caller right now.
 *
 * The first two values mirror `ApprovalBlockedReason` in `services/workflow.ts`
 * and carry the same meaning, so the UI can render one contract for both
 * engines. `SELF_APPROVAL_FORBIDDEN` is mail-specific: the author or requester
 * of a message may never decide its approval.
 */
export type MailApprovalBlockedReason =
  | 'EARLIER_STEP_PENDING'
  | 'ALREADY_DECIDED_EARLIER_STEP'
  | 'SELF_APPROVAL_FORBIDDEN';

export interface EmailApprovalRow {
  id: number;
  emailId: number;
  emailSubject: string | null;
  emailFolder: string | null;
  emailStatus: string | null;
  emailMailboxId: number | null;
  requiredLevel: number;
  approverRole: string | null;
  approverUserId: number | null;
  approverName: string | null;
  status: EmailApprovalStatus;
  classification: string | null;
  reason: string | null;
  decisionNote: string | null;
  requestedBy: number | null;
  requesterName: string | null;
  requestedAt: string | null;
  decidedBy: number | null;
  deciderName: string | null;
  decidedAt: string | null;
}

export interface PendingApprovalRow extends EmailApprovalRow {
  actionable: boolean;
  blockedReason: MailApprovalBlockedReason | null;
}

export interface RequestEmailApprovalInput {
  /** Role code whose holders may decide. Omit to allow any mail approver. */
  approverRole?: string | null;
  /** Pin the decision to one named user. Takes precedence over the role. */
  approverUserId?: number | null;
  /** Free-text justification shown to the approver. */
  reason?: string | null;
}

export interface EmailApprovalSubmission {
  approval: EmailApprovalRow;
  notifiedUserIds: number[];
}

export interface EmailApprovalDecisionResult {
  approval: EmailApprovalRow;
  emailStatus: string;
  emailApprovalState: string;
  /**
   * Present only when the decision closed the final level and the message was
   * released to the provider in the same transaction. Null for a rejection, a
   * return, or an interim approval with later levels still open.
   */
  send: SendStoredEmailResult | null;
}

type Decision = 'APPROVED' | 'REJECTED' | 'RETURNED';

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/** Human display name, falling back to the login address rather than an id. */
const NAME = (alias: string): string =>
  `COALESCE(NULLIF(trim(concat_ws(' ', ${alias}.first_name, ${alias}.last_name)), ''), ${alias}.email)`;

const APPROVAL_COLUMNS = `
  a.id, a.email_id, a.required_level, a.approver_role, a.approver_user_id,
  a.status, a.classification, a.reason, a.decision_note,
  a.requested_by, a.requested_at, a.decided_by, a.decided_at,
  e.subject AS email_subject, e.folder AS email_folder, e.status AS email_status,
  e.created_by AS email_created_by, e.mailbox_id AS email_mailbox_id,
  ${NAME('ru')} AS requester_name,
  ${NAME('du')} AS decider_name,
  ${NAME('au')} AS approver_name
`;

const APPROVAL_FROM = `
  FROM email_approvals a
  JOIN emails e ON e.id = a.email_id AND e.tenant_id = a.tenant_id
  LEFT JOIN users ru ON ru.id = a.requested_by
  LEFT JOIN users du ON du.id = a.decided_by
  LEFT JOIN users au ON au.id = a.approver_user_id
`;

const APPROVAL_ORDER = ` ORDER BY a.email_id DESC, a.required_level ASC, a.id ASC`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const text = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Permission codes that let a holder decide any unassigned mail approval. These
 * are the exact codes from the RBAC catalogue; the `.*` entries are accepted
 * because `can()` expands a literal `module.resource.*` grant.
 */
const DECIDER_CODES: ReadonlySet<string> = new Set([
  '*',
  'system.admin.all',
  'communication.admin',
  'communication.mail_approvals.approve',
  'communication.mail_approvals.reject',
  'communication.mail_approvals.manage',
  'communication.mail_approvals.*',
]);

function isApprovalDecider(permissions: readonly string[] | undefined): boolean {
  if (!permissions) return false;
  return permissions.some((p) => DECIDER_CODES.has(String(p)));
}

function toApproval(row: Record<string, unknown>): EmailApprovalRow {
  return {
    id: num(row.id),
    emailId: num(row.email_id),
    emailSubject: text(row.email_subject),
    emailFolder: text(row.email_folder),
    emailStatus: text(row.email_status),
    emailMailboxId: optNum(row.email_mailbox_id),
    requiredLevel: num(row.required_level) || 1,
    approverRole: text(row.approver_role),
    approverUserId: optNum(row.approver_user_id),
    approverName: text(row.approver_name),
    status: String(row.status ?? 'PENDING') as EmailApprovalStatus,
    classification: text(row.classification),
    reason: text(row.reason),
    decisionNote: text(row.decision_note),
    requestedBy: optNum(row.requested_by),
    requesterName: text(row.requester_name),
    requestedAt: iso(row.requested_at),
    decidedBy: optNum(row.decided_by),
    deciderName: text(row.decider_name),
    decidedAt: iso(row.decided_at),
  };
}

async function loadApproval(
  client: pg.PoolClient,
  tenantId: number,
  approvalId: number
): Promise<EmailApprovalRow | null> {
  const { rows } = await client.query(
    `SELECT ${APPROVAL_COLUMNS} ${APPROVAL_FROM} WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, approvalId]
  );
  return rows.length === 0 ? null : toApproval(rows[0]);
}

/**
 * Resolve who should be notified about a new approval request.
 *
 * An explicit assignee is honoured directly; a role narrows the pool of users
 * who actually hold the approve permission; with neither, every holder of the
 * permission is told - the same routing rule the service desk uses.
 */
async function approverPool(
  client: pg.PoolClient,
  ctx: Ctx,
  approverUserId: number | null,
  approverRole: string | null
): Promise<number[]> {
  const tenantId = ctx.tenantId ?? 0;
  if (approverUserId) {
    const { rows } = await client.query(
      `SELECT id FROM users
        WHERE id = $1 AND status = 'ACTIVE'
          AND (tenant_id = $2 OR tenant_id IS NULL)`,
      [approverUserId, tenantId]
    );
    return rows.length === 0 ? [] : [num(rows[0].id)];
  }
  const holders = await usersWithPermission(client, ctx, 'communication.mail_approvals.approve');
  if (!approverRole || holders.length === 0) return holders;
  const { rows } = await client.query(
    `SELECT DISTINCT ur.user_id AS id
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = $1 AND ur.user_id = ANY($2::bigint[])`,
    [approverRole, holders]
  );
  return rows.map((r) => num(r.id)).filter((id) => id > 0);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * Put a draft into the approval queue.
 *
 * Only the author may submit their own message, and only while it is still a
 * draft: a message that has been handed to the provider can never be parked for
 * approval after the fact.
 */
export async function submitForApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  emailId: number,
  input: RequestEmailApprovalInput = {}
): Promise<EmailApprovalSubmission> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  if (!emailId) throw badRequest('A message is required.');

  const { rows } = await client.query(
    `SELECT id, subject, status, folder, classification, created_by
       FROM emails WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
  if (rows.length === 0) throw notFound('Email not found');
  const email = rows[0] as Record<string, unknown>;

  const ownerId = num(email.created_by);
  if (!ownerId) throw forbidden('This message has no author, so it cannot be submitted for approval.');
  if (ownerId !== userId) {
    throw forbidden('Only the author of a message can submit it for approval.');
  }
  const emailStatus = String(email.status ?? 'DRAFT');
  if (emailStatus === 'SENT' || emailStatus === 'QUEUED' || emailStatus === 'SENDING') {
    throw conflict('This message has already been sent and cannot be submitted for approval.');
  }

  const outstanding = await client.query(
    `SELECT count(*)::int AS n FROM email_approvals
      WHERE tenant_id = $1 AND email_id = $2 AND status = 'PENDING'`,
    [tenantId, emailId]
  );
  if (num(outstanding.rows[0]?.n) > 0) {
    throw conflict('This message already has an approval decision outstanding.');
  }

  const approverRole = text(input.approverRole);
  const approverUserId = optNum(input.approverUserId);
  const reason = text(input.reason);
  if (reason && reason.length > 2000) {
    throw badRequest('The approval justification is too long (2000 characters maximum).');
  }

  // Stamp the classification from the policy table so the ledger records what
  // was actually enforced, not what the row happened to hold.
  const classification = await loadClassification(
    client,
    tenantId,
    String(email.classification ?? 'INTERNAL')
  );

  const levelRow = await client.query(
    `SELECT COALESCE(MAX(required_level), 0) + 1 AS next_level
       FROM email_approvals WHERE tenant_id = $1 AND email_id = $2`,
    [tenantId, emailId]
  );
  const requiredLevel = num(levelRow.rows[0]?.next_level) || 1;

  const inserted = await client.query(
    `INSERT INTO email_approvals
       (tenant_id, email_id, required_level, approver_role, approver_user_id,
        status, classification, reason, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      emailId,
      requiredLevel,
      approverRole,
      approverUserId,
      classification.code,
      reason,
      userId,
    ]
  );
  const approvalId = num(inserted.rows[0]?.id);

  await client.query(
    `UPDATE emails
        SET approval_state = 'PENDING', status = 'PENDING_APPROVAL', folder = 'DRAFTS', updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );

  await auditComms(client, ctx, 'EMAIL_APPROVAL_SUBMITTED', 'email', emailId, {
    approvalId,
    requiredLevel,
    approverRole,
    approverUserId,
    classification: classification.code,
  });

  const pool = await approverPool(client, ctx, approverUserId, approverRole);
  const subject = text(email.subject) ?? '(no subject)';
  const notifiedUserIds = pool.length
    ? await notifyUsers(
        client,
        ctx,
        {
          type: 'APPROVAL_REQUEST',
          title: 'Email approval required',
          body: `"${subject}" is waiting for your approval before it can be sent.`,
          link: '/communication/mail-approvals',
          entityType: 'email',
          entityId: emailId,
          priority: 'HIGH',
          severity: 'WARN',
          actionRequired: true,
          actionLabel: 'Review',
          actionTarget: '/communication/mail-approvals',
          data: {
            approvalId,
            emailId,
            requiredLevel,
            classification: classification.code,
          },
        },
        pool
      )
    : [];

  const approval = await loadApproval(client, tenantId, approvalId);
  if (!approval) throw notFound('Approval request not found');
  return { approval, notifiedUserIds };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Every approval ever raised on one message, oldest level first. */
export async function listEmailApprovals(
  client: pg.PoolClient,
  ctx: Ctx,
  emailId: number
): Promise<EmailApprovalRow[]> {
  const tenantId = ctx.tenantId ?? 0;
  if (!emailId) throw badRequest('A message is required.');
  const exists = await client.query(
    `SELECT 1 FROM emails WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
  if (exists.rows.length === 0) throw notFound('Email not found');
  const { rows } = await client.query(
    `SELECT ${APPROVAL_COLUMNS} ${APPROVAL_FROM}
      WHERE a.tenant_id = $1 AND a.email_id = $2${APPROVAL_ORDER}`,
    [tenantId, emailId]
  );
  return rows.map(toApproval);
}

/**
 * The caller's approval queue.
 *
 * Mirrors `getApprovalsQueue`'s contract: rows stay visible to a holder of a
 * later level so they know the decision is coming, annotated with `actionable`
 * and `blockedReason` rather than being hidden or offered as a button that
 * returns 403. Neither flag is an authorisation decision - the decide path
 * re-checks every rule inside its own transaction.
 */
export async function listPendingApprovals(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  options: { emailId?: number; limit?: number } = {}
): Promise<PendingApprovalRow[]> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  const decider = isApprovalDecider(permissions);

  const params: unknown[] = [tenantId, userId];
  const visibility = decider
    ? `(a.approver_user_id = $2
        OR (a.approver_user_id IS NULL
            AND (a.approver_role IS NULL
                 OR EXISTS (SELECT 1 FROM user_roles ur
                              JOIN roles r ON r.id = ur.role_id
                             WHERE ur.user_id = $2 AND r.code = a.approver_role))))`
    : `a.approver_user_id = $2`;

  const where: string[] = [`a.tenant_id = $1`, `a.status = 'PENDING'`, visibility];
  if (options.emailId) {
    params.push(options.emailId);
    where.push(`a.email_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(num(options.limit) || 200, 1), 500);
  params.push(limit);

  const { rows } = await client.query(
    `SELECT ${APPROVAL_COLUMNS},
            NOT EXISTS (
              SELECT 1 FROM email_approvals earlier
               WHERE earlier.tenant_id = a.tenant_id
                 AND earlier.email_id = a.email_id
                 AND earlier.required_level < a.required_level
                 AND earlier.status = 'PENDING'
            ) AS stage_ready,
            EXISTS (
              SELECT 1 FROM email_approvals prior
               WHERE prior.tenant_id = a.tenant_id
                 AND prior.email_id = a.email_id
                 AND prior.required_level < a.required_level
                 AND prior.decided_by = $2
                 AND prior.status IN ('APPROVED', 'REJECTED', 'RETURNED')
            ) AS prior_decided_by_me,
            (a.requested_by = $2 OR e.created_by = $2) AS self_authored
       ${APPROVAL_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY a.requested_at ASC, a.id ASC
      LIMIT $${params.length}`,
    params
  );

  return rows.map((row) => {
    const approval = toApproval(row);
    const blockedReason: MailApprovalBlockedReason | null =
      row.self_authored === true
        ? 'SELF_APPROVAL_FORBIDDEN'
        : row.stage_ready !== true
          ? 'EARLIER_STEP_PENDING'
          : row.prior_decided_by_me === true
            ? 'ALREADY_DECIDED_EARLIER_STEP'
            : null;
    return { ...approval, actionable: blockedReason === null, blockedReason };
  });
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/** Reject a decision from someone who is not the designated or role approver. */
async function assertCanDecide(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  approval: Record<string, unknown>
): Promise<void> {
  const userId = ctx.userId ?? 0;
  const assigned = optNum(approval.approver_user_id);
  if (assigned) {
    if (assigned !== userId) {
      throw forbidden('This approval is assigned to another approver.');
    }
    return;
  }
  const role = text(approval.approver_role);
  if (role) {
    const { rows } = await client.query(
      `SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.code = $2
        LIMIT 1`,
      [userId, role]
    );
    if (rows.length === 0 && !isApprovalDecider(permissions)) {
      throw forbidden(`This approval must be decided by a member of the ${role} role.`);
    }
    return;
  }
  if (!isApprovalDecider(permissions)) {
    throw forbidden('You do not have permission to decide mail approvals.');
  }
}

/**
 * Apply one decision under an advisory lock.
 *
 * The lock is what makes two simultaneous approvals safe: without it both
 * approvers could read PENDING and both decide. It is released automatically at
 * transaction end, and `applyContext` always runs inside a transaction, so the
 * lock and the row update are never split.
 */
async function decide(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  approvalId: number,
  decision: Decision,
  note: string | null
): Promise<EmailApprovalDecisionResult> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  if (!approvalId) throw badRequest('An approval decision is required.');
  if ((decision === 'REJECTED' || decision === 'RETURNED') && !note) {
    throw badRequest(
      decision === 'REJECTED'
        ? 'A reason is required to reject a message.'
        : 'A note is required to return a message for changes.'
    );
  }
  if (note && note.length > 2000) {
    throw badRequest('The decision note is too long (2000 characters maximum).');
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `mail_approval:${approvalId}`,
  ]);

  const found = await client.query(
    `SELECT ${APPROVAL_COLUMNS} ${APPROVAL_FROM} WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, approvalId]
  );
  if (found.rows.length === 0) throw notFound('Approval request not found');
  const row = found.rows[0] as Record<string, unknown>;
  const approval = toApproval(row);

  if (approval.status !== 'PENDING') {
    throw conflict(`This approval was already ${approval.status.toLowerCase()}.`);
  }

  await assertCanDecide(client, ctx, permissions, row);

  // Segregation of duties: the person who asked for the approval, and the
  // person who wrote the message, may never be the person who approves it.
  if (userId === approval.requestedBy || userId === num(row.email_created_by)) {
    throw forbidden(
      'You requested this approval, so you cannot decide it. Another authorised approver must decide.'
    );
  }

  const earlier = await client.query(
    `SELECT count(*)::int AS n FROM email_approvals
      WHERE tenant_id = $1 AND email_id = $2 AND required_level < $3 AND status = 'PENDING'`,
    [tenantId, approval.emailId, approval.requiredLevel]
  );
  if (num(earlier.rows[0]?.n) > 0) {
    throw conflict('An earlier approval step on this message is still outstanding.');
  }

  const prior = await client.query(
    `SELECT count(*)::int AS n FROM email_approvals
      WHERE tenant_id = $1 AND email_id = $2 AND required_level < $3
        AND decided_by = $4 AND status IN ('APPROVED', 'REJECTED', 'RETURNED')`,
    [tenantId, approval.emailId, approval.requiredLevel, userId]
  );
  if (num(prior.rows[0]?.n) > 0) {
    throw forbidden(
      'You already decided an earlier step on this message. Segregation of duties requires a different approver for a later step.'
    );
  }

  await client.query(
    `UPDATE email_approvals
        SET status = $2, decision_note = $3, decided_by = $4, decided_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $5`,
    [approvalId, decision, note, userId, tenantId]
  );

  // A rejection or return ends the chain: any other open level is moot and must
  // not stay decidable, or a later approver could approve a rejected message.
  if (decision !== 'APPROVED') {
    await client.query(
      `UPDATE email_approvals
          SET status = 'CANCELLED', updated_at = now()
        WHERE tenant_id = $1 AND email_id = $2 AND status = 'PENDING' AND id <> $3`,
      [tenantId, approval.emailId, approvalId]
    );
  }

  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM email_approvals
      WHERE tenant_id = $1 AND email_id = $2 AND status = 'PENDING'`,
    [tenantId, approval.emailId]
  );
  const stillPending = num(remaining.rows[0]?.n) > 0;

  let emailStatus: string;
  let emailApprovalState: string;
  if (decision === 'APPROVED') {
    emailApprovalState = stillPending ? 'PENDING' : 'APPROVED';
    // The final approval re-enters `sendStoredEmail` below, which overwrites
    // this with the real outcome; until then the message stays parked in the
    // approval queue.
    emailStatus = 'PENDING_APPROVAL';
  } else {
    emailApprovalState = decision;
    emailStatus = 'DRAFT';
  }

  if (decision !== 'APPROVED') {
    await client.query(
      `UPDATE emails
          SET approval_state = $2, status = 'DRAFT', folder = 'DRAFTS', updated_at = now()
        WHERE id = $1 AND tenant_id = $3`,
      [approval.emailId, emailApprovalState, tenantId]
    );
  } else {
    await client.query(
      `UPDATE emails SET approval_state = $2, updated_at = now()
        WHERE id = $1 AND tenant_id = $3`,
      [approval.emailId, emailApprovalState, tenantId]
    );
  }

  await auditComms(
    client,
    ctx,
    decision === 'APPROVED'
      ? 'EMAIL_APPROVAL_APPROVED'
      : decision === 'REJECTED'
        ? 'EMAIL_APPROVAL_REJECTED'
        : 'EMAIL_APPROVAL_RETURNED',
    'email',
    approval.emailId,
    { approvalId, requiredLevel: approval.requiredLevel, note, stillPending }
  );

  const requesterId = approval.requestedBy;
  if (requesterId) {
    const subject = approval.emailSubject ?? '(no subject)';
    await notifyUsers(
      client,
      ctx,
      {
        type: decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
        title:
          decision === 'APPROVED'
            ? 'Email approved'
            : decision === 'REJECTED'
              ? 'Email approval rejected'
              : 'Email returned for changes',
        body:
          decision === 'APPROVED'
            ? `"${subject}" was approved${stillPending ? ' at this level' : ''}.`
            : `"${subject}" was ${decision === 'REJECTED' ? 'rejected' : 'returned for changes'}${note ? `: ${note}` : '.'}`,
        link: '/communication/drafts',
        entityType: 'email',
        entityId: approval.emailId,
        severity: decision === 'APPROVED' ? 'SUCCESS' : decision === 'REJECTED' ? 'ERROR' : 'WARN',
        priority: 'HIGH',
        data: { approvalId, emailId: approval.emailId, decision, note },
      },
      [requesterId]
    );
  }

  const updated = await loadApproval(client, tenantId, approvalId);
  if (!updated) throw notFound('Approval request not found');

  // Release only when the chain is fully closed. `sendStoredEmail` re-verifies
  // that this caller is the recorded approver of an APPROVED row with nothing
  // still pending, so this branch cannot become a send bypass.
  let send: SendStoredEmailResult | null = null;
  if (decision === 'APPROVED' && !stillPending) {
    send = await sendStoredEmail(client, ctx, permissions, approval.emailId, {
      release: { approvalId },
    });
    emailStatus = send.outcome;
  }

  return {
    approval: updated,
    emailStatus,
    emailApprovalState,
    send,
  };
}

/** Approve a message; the final approval releases it to the provider. */
export async function approveEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  approvalId: number,
  decisionNote?: string | null
): Promise<EmailApprovalDecisionResult> {
  return decide(client, ctx, permissions, approvalId, 'APPROVED', text(decisionNote));
}

/** Reject a message. A reason is mandatory; nothing is sent. */
export async function rejectEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  approvalId: number,
  decisionNote: string
): Promise<EmailApprovalDecisionResult> {
  return decide(client, ctx, permissions, approvalId, 'REJECTED', text(decisionNote));
}

/** Return a message to its author for changes. A note is mandatory; nothing is sent. */
export async function returnEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  approvalId: number,
  decisionNote: string
): Promise<EmailApprovalDecisionResult> {
  return decide(client, ctx, permissions, approvalId, 'RETURNED', text(decisionNote));
}
