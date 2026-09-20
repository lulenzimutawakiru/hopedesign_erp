/**
 * HOPE DESIGN ERP - Company Mailing System (ops router).
 *
 * Mounted at `/api/ops/mail` as a sibling of the legacy `/api/ops/communication`
 * router. RBAC only: the module gate is applied by the navigation/permission
 * catalogue, not here, because mail is a cross-module capability.
 *
 * Invariants enforced in this file:
 *   - every route is permission gated with requirePermission();
 *   - every message operation resolves mailbox access and asserts the specific
 *     mailbox flag (view/send/reply/delete/archive/delegate/export/admin);
 *   - classification policy denies VIEW/FORWARD/DOWNLOAD/PRINT/EXPORT;
 *   - every outbound mail funnels through sendStoredEmail() so the approval
 *     gate, recipient validation and provider id recording cannot be bypassed;
 *   - provider credentials are never selected into a response;
 *   - privileged actions are written to communication_audit_logs with the
 *     mailbox/message dimension populated.
 */
import { Router } from 'express';
import pg from 'pg';
import { tx, pool, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import {
  asyncHandler,
  badRequest,
  forbidden,
  notFound,
  conflict,
  parsePagination,
  toCamelRow,
  toCamelRows,
} from '../../utils.js';
import type { AuthUser } from '../../types.js';
import { messagingLimiter } from '../../middleware/rateLimits.js';
import {
  isMailAdmin,
  expireMailDelegations,
  listMailboxesForUser,
  resolveMailboxAccess,
  assertMailboxPermission,
  mailboxIdOf,
  type MailboxAccess,
} from '../../services/mail/access.js';
import { sendStoredEmail, tenantMailDomains } from '../../services/mail/send.js';
import {
  submitForApproval,
  listEmailApprovals,
  listPendingApprovals,
  approveEmail,
  rejectEmail,
  returnEmail,
} from '../../services/mail/approvals.js';
import {
  fallbackClassification,
  loadClassification,
  listClassifications,
  assertClassificationAllows,
  classificationBlockReason,
  hasExternalRecipient,
  type MailClassification,
} from '../../services/mail/policy.js';
import {
  listUsableSignatures,
  resolveSignature,
  defaultSignature,
  toSignature,
} from '../../services/mail/signatures.js';
import {
  recordDeliveryEvent,
  listDeliveryEvents,
  confirmedStatus,
} from '../../services/mail/delivery.js';
import { auditComms, notifyUsers } from '../../services/communication.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../../config.js';
import { encryptSecret } from '../../services/companyConfig.js';

export const mailOpsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: any,
  params: Record<string, string>,
  auth?: AuthUser
) => Promise<unknown>;
type QueryFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  query: Record<string, unknown>,
  params: Record<string, string>,
  auth?: AuthUser
) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>, req.auth),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>, req.auth),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const NUM = (v: unknown): number | null =>
  v === undefined || v === null || v === '' ? null : Number(v);
const stripTotal = (r: Record<string, unknown>): Record<string, unknown> => {
  const { _total, ...rest } = r;
  return rest;
};
const boolOf = (v: unknown): boolean | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
};
const idOf = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${label}`);
  return n;
};
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** Recipient list normaliser: accepts "a@b.c", "Name <a@b.c>" or arrays/CSV. */
const parseAddressList = (raw: unknown): string[] => {
  const out: string[] = [];
  const push = (entry: unknown) => {
    if (entry === undefined || entry === null) return;
    const s = String(entry).trim();
    if (!s) return;
    const angled = /<\s*([^>]+)\s*>\s*$/.exec(s);
    const addr = (angled ? angled[1] : s).trim().toLowerCase();
    if (EMAIL_RE.test(addr) && !out.includes(addr)) out.push(addr);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === 'string') raw.split(/[,;\n]/).forEach(push);
  return out;
};

const MAILBOX_KINDS = ['INDIVIDUAL', 'DEPARTMENT', 'SHARED', 'SYSTEM', 'DISTRIBUTION'];
const WORKSPACE_FOLDERS = ['INBOX', 'SENT', 'DRAFTS', 'SCHEDULED', 'OUTBOX', 'ARCHIVE', 'TRASH', 'SPAM'];
const SORTABLE = new Set([
  'created_at',
  'updated_at',
  'sent_at',
  'scheduled_at',
  'subject',
  'priority',
  'status',
  'classification',
  'is_read',
]);

/** The mailbox a caller may act on, with the flags relevant to the action. */
interface MessageContext {
  email: Record<string, unknown>;
  access: MailboxAccess | null;
  classification: MailClassification;
}

/**
 * Legacy rows created before mailboxes existed have mailbox_id = NULL. They stay
 * reachable to their author (or a mail administrator) but never to anyone else.
 */
function isLegacyRow(email: Record<string, unknown>): boolean {
  return email.mailbox_id === null || email.mailbox_id === undefined;
}

function assertLegacyOwnership(
  email: Record<string, unknown>,
  ctx: Ctx,
  permissions: readonly string[] | undefined
): void {
  const userId = ctx.userId ?? 0;
  const mine =
    Number(email.created_by) === userId ||
    Number(email.sent_by) === userId;
  if (!mine && !isMailAdmin(permissions)) {
    throw forbidden('You do not have access to this message');
  }
}

/** Load a message the caller may read, enforcing mailbox + classification policy. */
async function loadForRead(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  emailId: number
): Promise<MessageContext> {
  const { rows } = await client.query(
    `SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`,
    [emailId, ctx.tenantId ?? 0]
  );
  if (rows.length === 0) throw notFound('Message not found');
  const email = rows[0] as Record<string, unknown>;

  let access: MailboxAccess | null = null;
  const mailboxId = mailboxIdOf(email);
  if (mailboxId) {
    access = await resolveMailboxAccess(client, ctx, permissions, mailboxId);
    assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
  } else {
    assertLegacyOwnership(email, ctx, permissions);
  }

  const classification = await loadClassification(client, ctx.tenantId ?? 0, String(email.classification ?? 'INTERNAL'));
  assertClassificationAllows(classification, 'VIEW');

  return { email, access, classification };
}

/** Load a message the caller may mutate, asserting one mailbox flag. */
async function loadForWrite(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  emailId: number,
  flag: Parameters<typeof assertMailboxPermission>[1],
  message: string
): Promise<MessageContext> {
  const loaded = await loadForRead(client, ctx, permissions, emailId);
  if (loaded.access) assertMailboxPermission(loaded.access, flag, message);
  else if (!isMailAdmin(permissions)) assertLegacyOwnership(loaded.email, ctx, permissions);
  return loaded;
}

/** Accessible mailbox ids for the caller, used to scope every list query. */
async function accessibleMailboxIds(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined
): Promise<number[]> {
  const list = await listMailboxesForUser(client, ctx, permissions);
  return list.map((a) => a.mailboxId);
}

/**
 * Mailbox-scoped audit row. Captures the mailbox/message dimension that the
 * shared auditComms() helper omits, in a single insert (no post-hoc lookup).
 */
async function auditMail(
  client: pg.PoolClient,
  ctx: Ctx,
  action: string,
  targetType: string,
  targetId: number | null,
  detail: Record<string, unknown> = {},
  mailboxId: number | null = null,
  result = 'SUCCESS'
): Promise<void> {
  await client.query(
    `INSERT INTO communication_audit_logs
       (tenant_id, company_id, user_id, action, target_type, target_id, detail,
        ip, user_agent, mailbox_id, message_id, device, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.tenantId ?? 0, ctx.companyId ?? null, ctx.userId ?? null, action, targetType, targetId,
     JSON.stringify(detail), ctx.ip ?? null, ctx.userAgent ?? null, mailboxId,
     targetId !== null && targetType === 'email' ? String(targetId) : null,
     ctx.device ?? null, result]
  );
}

/** Public mailbox projection: never leaks owner internals beyond id/name. */
function mailboxView(access: MailboxAccess): Record<string, unknown> {
  const mb = access.mailbox ?? {};
  return {
    id: access.mailboxId,
    code: mb.code ?? null,
    address: mb.address ?? null,
    displayName: mb.display_name ?? null,
    kind: mb.kind ?? null,
    departmentId: mb.department_id ?? null,
    ownerUserId: mb.owner_user_id ?? null,
    description: mb.description ?? null,
    defaultClassification: mb.default_classification ?? 'INTERNAL',
    defaultSenderName: mb.default_sender_name ?? null,
    allowExternalSend: mb.allow_external_send !== false,
    requireApproval: mb.require_approval === true,
    isActive: mb.is_active !== false,
    permissions: {
      canView: access.canView,
      canSend: access.canSend,
      canReply: access.canReply,
      canDelete: access.canDelete,
      canArchive: access.canArchive,
      canDelegate: access.canDelegate,
      canExport: access.canExport,
      canAdmin: access.canAdmin,
    },
    memberRole: access.memberRole,
    viaDelegation: access.viaDelegation,
    delegationId: access.delegationId,
    onBehalfOfUserId: access.onBehalfOfUserId,
    onBehalfOfName: access.onBehalfOfName,
    globalAdmin: access.globalAdmin,
  };
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

mailOpsRouter.get(
  '/mailboxes',
  ...runGet('communication.mailboxes.view', async (c, ctx, q, _p, auth) => {
    const all = await listMailboxesForUser(c, ctx, auth?.permissions);
    const kind = typeof q.kind === 'string' && q.kind ? String(q.kind).toUpperCase() : null;
    const rows = kind ? all.filter((a) => String(a.mailbox.kind) === kind) : all;
    return { mailboxes: rows.map(mailboxView) };
  })
);

mailOpsRouter.get(
  '/mailboxes/:id',
  ...runGet('communication.mailboxes.view', async (c, ctx, _q, p, auth) => {
    const access = await resolveMailboxAccess(c, ctx, auth?.permissions, idOf(p.id, 'mailbox id'));
    return mailboxView(access);
  })
);

mailOpsRouter.post(
  '/mailboxes',
  ...run('communication.mailboxes.create', async (c, ctx, b) => {
    const code = String(b.code ?? '').trim();
    const address = String(b.address ?? '').trim().toLowerCase();
    const displayName = String(b.displayName ?? b.display_name ?? '').trim();
    if (!code || !address || !displayName) throw badRequest('code, address and displayName are required');
    if (!EMAIL_RE.test(address)) throw badRequest('address must be a valid email address');
    const kind = String(b.kind ?? 'SHARED').toUpperCase();
    if (!MAILBOX_KINDS.includes(kind)) throw badRequest(`kind must be one of ${MAILBOX_KINDS.join(', ')}`);
    const classification = String(b.defaultClassification ?? b.default_classification ?? 'INTERNAL').toUpperCase();
    await loadClassification(c, ctx.tenantId ?? 0, classification);

    const dup = await c.query(`SELECT 1 FROM mailboxes WHERE tenant_id = $1 AND (code = $2 OR address = $3)`, [
      ctx.tenantId ?? 0,
      code,
      address,
    ]);
    if (dup.rowCount) throw conflict('A mailbox with that code or address already exists');

    const { rows } = await c.query(
      `INSERT INTO mailboxes
         (tenant_id, company_id, branch_id, code, address, display_name, kind, department_id,
          owner_user_id, description, default_classification, default_sender_name,
          allow_external_send, require_approval, retention_days, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16)
       RETURNING id`,
      [
        ctx.tenantId ?? 0,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        code,
        address,
        displayName,
        kind,
        NUM(b.departmentId ?? b.department_id),
        NUM(b.ownerUserId ?? b.owner_user_id),
        b.description ?? null,
        classification,
        b.defaultSenderName ?? b.default_sender_name ?? displayName,
        b.allowExternalSend === undefined ? true : boolOf(b.allowExternalSend) ?? true,
        boolOf(b.requireApproval ?? b.require_approval) ?? false,
        NUM(b.retentionDays ?? b.retention_days),
        ctx.userId ?? null,
      ]
    );
    const id = Number(rows[0].id);
    await auditComms(c, ctx, 'MAILBOX_CREATED', 'mailbox', id, { code, address, kind });
    const access = await resolveMailboxAccess(c, ctx, ['*'], id);
    return mailboxView(access);
  })
);

mailOpsRouter.patch(
  '/mailboxes/:id',
  ...run('communication.mailboxes.update', async (c, ctx, b, p) => {
    const id = idOf(p.id, 'mailbox id');
    const { rows: existing } = await c.query(`SELECT * FROM mailboxes WHERE id = $1 AND tenant_id = $2`, [
      id,
      ctx.tenantId ?? 0,
    ]);
    if (existing.length === 0) throw notFound('Mailbox not found');

    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    const text = (v: unknown) => (v === undefined || v === null ? null : String(v).trim());

    if (b.displayName !== undefined || b.display_name !== undefined) {
      const v = text(b.displayName ?? b.display_name);
      if (!v) throw badRequest('displayName cannot be empty');
      set('display_name', v);
    }
    if (b.description !== undefined) set('description', b.description ?? null);
    if (b.departmentId !== undefined || b.department_id !== undefined)
      set('department_id', NUM(b.departmentId ?? b.department_id));
    if (b.ownerUserId !== undefined || b.owner_user_id !== undefined)
      set('owner_user_id', NUM(b.ownerUserId ?? b.owner_user_id));
    if (b.defaultSenderName !== undefined || b.default_sender_name !== undefined)
      set('default_sender_name', text(b.defaultSenderName ?? b.default_sender_name));
    if (b.allowExternalSend !== undefined || b.allow_external_send !== undefined)
      set('allow_external_send', boolOf(b.allowExternalSend ?? b.allow_external_send) ?? true);
    if (b.requireApproval !== undefined || b.require_approval !== undefined)
      set('require_approval', boolOf(b.requireApproval ?? b.require_approval) ?? false);
    if (b.retentionDays !== undefined || b.retention_days !== undefined)
      set('retention_days', NUM(b.retentionDays ?? b.retention_days));
    if (b.isActive !== undefined || b.is_active !== undefined)
      set('is_active', boolOf(b.isActive ?? b.is_active) ?? true);
    if (b.defaultClassification !== undefined || b.default_classification !== undefined) {
      const code = String(b.defaultClassification ?? b.default_classification).toUpperCase();
      await loadClassification(c, ctx.tenantId ?? 0, code);
      set('default_classification', code);
    }
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    await c.query(
      `UPDATE mailboxes SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      params
    );
    await auditComms(c, ctx, 'MAILBOX_UPDATED', 'mailbox', id, { fields: sets.map((s) => s.split(' =')[0]) });
    const access = await resolveMailboxAccess(c, ctx, ['*'], id);
    return mailboxView(access);
  })
);

// ---------------------------------------------------------------------------
// Mailbox members
// ---------------------------------------------------------------------------

mailOpsRouter.get(
  '/mailboxes/:id/members',
  ...runGet('communication.mailbox_members.view', async (c, ctx, _q, p, auth) => {
    const id = idOf(p.id, 'mailbox id');
    const access = await resolveMailboxAccess(c, ctx, auth?.permissions, id);
    assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    const { rows } = await c.query(
      `SELECT m.*, u.first_name, u.last_name, u.username, u.email
         FROM mailbox_members m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.mailbox_id = $1
        ORDER BY m.member_role, m.id`,
      [id]
    );
    return { members: toCamelRows(rows) };
  })
);

mailOpsRouter.post(
  '/mailboxes/:id/members',
  ...run('communication.mailbox_members.create', async (c, ctx, b, p) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const userId = idOf(b.userId ?? b.user_id, 'user id');
    const memberRole = String(b.memberRole ?? b.member_role ?? 'MEMBER').toUpperCase();
    if (!['OWNER', 'MANAGER', 'MEMBER', 'READ_ONLY'].includes(memberRole))
      throw badRequest('memberRole must be OWNER, MANAGER, MEMBER or READ_ONLY');

    // Verifies the mailbox exists in this tenant (404) before a member is attached.
    await resolveMailboxAccess(c, ctx, ['*'], mailboxId);
    const { rows: userRows } = await c.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [
      userId,
      ctx.tenantId ?? 0,
    ]);
    if (userRows.length === 0) throw notFound('User not found in this tenant');

    const flag = (v: unknown, fallback: boolean): boolean => (v === undefined ? fallback : boolOf(v) ?? fallback);
    const { rows } = await c.query(
      `INSERT INTO mailbox_members
         (tenant_id, mailbox_id, user_id, member_role, can_view, can_send, can_reply,
          can_delete, can_archive, can_delegate, can_export, can_admin, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
       ON CONFLICT (mailbox_id, user_id) DO UPDATE SET
         member_role = EXCLUDED.member_role,
         can_view = EXCLUDED.can_view, can_send = EXCLUDED.can_send, can_reply = EXCLUDED.can_reply,
         can_delete = EXCLUDED.can_delete, can_archive = EXCLUDED.can_archive,
         can_delegate = EXCLUDED.can_delegate, can_export = EXCLUDED.can_export,
         can_admin = EXCLUDED.can_admin, is_active = true, updated_at = now()
       RETURNING id`,
      [
        ctx.tenantId ?? 0,
        mailboxId,
        userId,
        memberRole,
        flag(b.canView ?? b.can_view, true),
        flag(b.canSend ?? b.can_send, true),
        flag(b.canReply ?? b.can_reply, true),
        flag(b.canDelete ?? b.can_delete, false),
        flag(b.canArchive ?? b.can_archive, false),
        flag(b.canDelegate ?? b.can_delegate, false),
        flag(b.canExport ?? b.can_export, false),
        flag(b.canAdmin ?? b.can_admin, false),
        ctx.userId ?? null,
      ]
    );
    const memberId = Number(rows[0].id);
    await auditComms(c, ctx, 'MAILBOX_MEMBER_SET', 'mailbox_member', memberId, { mailboxId, userId, memberRole });
    return { id: memberId, mailboxId, userId, memberRole };
  })
);

mailOpsRouter.patch(
  '/mailboxes/:id/members/:userId',
  ...run('communication.mailbox_members.update', async (c, ctx, b, p) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const userId = idOf(p.userId, 'user id');
    await resolveMailboxAccess(c, ctx, ['*'], mailboxId);

    const sets: string[] = [];
    const params: unknown[] = [mailboxId, userId];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.memberRole !== undefined || b.member_role !== undefined) {
      const role = String(b.memberRole ?? b.member_role).toUpperCase();
      if (!['OWNER', 'MANAGER', 'MEMBER', 'READ_ONLY'].includes(role))
        throw badRequest('memberRole must be OWNER, MANAGER, MEMBER or READ_ONLY');
      set('member_role', role);
    }
    const flags: Array<[string, string]> = [
      ['can_view', 'canView'],
      ['can_send', 'canSend'],
      ['can_reply', 'canReply'],
      ['can_delete', 'canDelete'],
      ['can_archive', 'canArchive'],
      ['can_delegate', 'canDelegate'],
      ['can_export', 'canExport'],
      ['can_admin', 'canAdmin'],
    ];
    for (const [col, camel] of flags) {
      const v = b[camel] ?? b[col];
      if (v !== undefined) set(col, boolOf(v) ?? false);
    }
    if (b.isActive !== undefined || b.is_active !== undefined)
      set('is_active', boolOf(b.isActive ?? b.is_active) ?? true);
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    const { rowCount } = await c.query(
      `UPDATE mailbox_members SET ${sets.join(', ')}, updated_at = now()
        WHERE mailbox_id = $1 AND user_id = $2`,
      params
    );
    if (!rowCount) throw notFound('Mailbox member not found');
    await auditComms(c, ctx, 'MAILBOX_MEMBER_UPDATED', 'mailbox_member', null, {
      mailboxId,
      userId,
      fields: sets.map((s) => s.split(' =')[0]),
    });
    return { mailboxId, userId };
  })
);

mailOpsRouter.delete(
  '/mailboxes/:id/members/:userId',
  ...run('communication.mailbox_members.delete', async (c, ctx, _b, p) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const userId = idOf(p.userId, 'user id');
    await resolveMailboxAccess(c, ctx, ['*'], mailboxId);
    const { rowCount } = await c.query(`DELETE FROM mailbox_members WHERE mailbox_id = $1 AND user_id = $2`, [
      mailboxId,
      userId,
    ]);
    if (!rowCount) throw notFound('Mailbox member not found');
    await auditComms(c, ctx, 'MAILBOX_MEMBER_REMOVED', 'mailbox_member', null, { mailboxId, userId });
    return { mailboxId, userId, removed: true };
  })
);

// ---------------------------------------------------------------------------
// Delegations (auto-expiring)
// ---------------------------------------------------------------------------

mailOpsRouter.get(
  '/mailboxes/:id/delegations',
  ...runGet('communication.mailbox_delegations.view', async (c, ctx, _q, p, auth) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
    assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    await expireMailDelegations(c, ctx.tenantId ?? 0);
    const { rows } = await c.query(
      `SELECT d.*, du.first_name AS delegate_first_name, du.last_name AS delegate_last_name,
              ou.first_name AS delegator_first_name, ou.last_name AS delegator_last_name
         FROM mailbox_delegations d
         LEFT JOIN users du ON du.id = d.delegate_user_id
         LEFT JOIN users ou ON ou.id = d.delegator_user_id
        WHERE d.mailbox_id = $1 AND d.tenant_id = $2
        ORDER BY d.created_at DESC`,
      [mailboxId, ctx.tenantId ?? 0]
    );
    return { delegations: toCamelRows(rows) };
  })
);

mailOpsRouter.post(
  '/mailboxes/:id/delegations',
  ...run('communication.mailbox_delegations.create', async (c, ctx, b, p) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const delegateUserId = idOf(b.delegateUserId ?? b.delegate_user_id, 'delegate user id');
    const endsAt = b.endsAt ?? b.ends_at;
    if (!endsAt) throw badRequest('endsAt is required: delegations must expire');
    const end = new Date(String(endsAt));
    if (Number.isNaN(end.getTime())) throw badRequest('endsAt must be a valid date');
    if (end.getTime() <= Date.now()) throw badRequest('endsAt must be in the future');
    const startsAt = b.startsAt ?? b.starts_at ? new Date(String(b.startsAt ?? b.starts_at)) : new Date();
    if (Number.isNaN(startsAt.getTime())) throw badRequest('startsAt must be a valid date');
    if (end.getTime() <= startsAt.getTime()) throw badRequest('endsAt must be after startsAt');

    const access = await resolveMailboxAccess(c, ctx, ['*'], mailboxId);
    const { rows: delegate } = await c.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [
      delegateUserId,
      ctx.tenantId ?? 0,
    ]);
    if (delegate.length === 0) throw notFound('Delegate user not found in this tenant');
    if (delegateUserId === ctx.userId) throw badRequest('You cannot delegate a mailbox to yourself');

    const permissions = Array.isArray(b.permissions)
      ? b.permissions.map((x: unknown) => String(x))
      : parsePermissionTokens(b.permissions);
    const canSendOnBehalf = boolOf(b.canSendOnBehalf ?? b.can_send_on_behalf) ?? true;

    const { rows } = await c.query(
      `INSERT INTO mailbox_delegations
         (tenant_id, mailbox_id, delegator_user_id, delegate_user_id, permissions,
          can_send_on_behalf, starts_at, ends_at, reason, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'ACTIVE')
       RETURNING id`,
      [
        ctx.tenantId ?? 0,
        mailboxId,
        ctx.userId ?? null,
        delegateUserId,
        JSON.stringify(permissions),
        canSendOnBehalf,
        startsAt.toISOString(),
        end.toISOString(),
        b.reason ?? null,
      ]
    );
    const id = Number(rows[0].id);
    await auditComms(c, ctx, 'MAILBOX_DELEGATION_CREATED', 'mailbox_delegation', id, {
      mailboxId,
      delegateUserId,
      permissions,
      endsAt: end.toISOString(),
      mailboxCode: access.mailbox.code ?? null,
    });
    await notifyUsers(
      c,
      ctx,
      {
        type: 'MAIL_DELEGATION',
        title: 'Mailbox access delegated to you',
        body: `You can act on the ${String(access.mailbox.display_name ?? 'mailbox')} mailbox until ${end.toISOString().slice(0, 10)}.`,
        link: '/communication/mailboxes',
        entityType: 'mailbox',
        entityId: mailboxId,
        severity: 'INFO',
      },
      [delegateUserId]
    );
    return { id, mailboxId, delegateUserId, permissions, startsAt: startsAt.toISOString(), endsAt: end.toISOString() };
  })
);

mailOpsRouter.post(
  '/delegations/:id/revoke',
  ...run('communication.mailbox_delegations.revoke', async (c, ctx, b, p) => {
    const id = idOf(p.id, 'delegation id');
    const { rows } = await c.query(
      `SELECT * FROM mailbox_delegations WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Delegation not found');
    const delegation = rows[0] as Record<string, unknown>;
    if (String(delegation.status) === 'REVOKED') throw conflict('This delegation is already revoked');
    if (String(delegation.status) === 'EXPIRED') throw conflict('This delegation has already expired');

    await resolveMailboxAccess(c, ctx, ['*'], Number(delegation.mailbox_id));
    await c.query(
      `UPDATE mailbox_delegations
          SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, updated_at = now()
        WHERE id = $1 AND tenant_id = $3`,
      [id, ctx.userId ?? null, ctx.tenantId ?? 0]
    );
    await auditComms(c, ctx, 'MAILBOX_DELEGATION_REVOKED', 'mailbox_delegation', id, {
      mailboxId: Number(delegation.mailbox_id),
      delegateUserId: Number(delegation.delegate_user_id),
      reason: b.reason ?? null,
    });
    return { id, status: 'REVOKED' };
  })
);

// ---------------------------------------------------------------------------
// Classifications
// ---------------------------------------------------------------------------

mailOpsRouter.get(
  '/classifications',
  ...runGet('communication.mail_classifications.view', async (c, ctx) => {
    const active = await listClassifications(c, ctx.tenantId ?? 0);
    return { classifications: active };
  })
);

mailOpsRouter.patch(
  '/classifications/:id',
  ...run('communication.mail_classifications.manage', async (c, ctx, b, p) => {
    const id = idOf(p.id, 'classification id');
    const { rows: existing } = await c.query(
      `SELECT * FROM email_classifications WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    if (existing.length === 0) throw notFound('Classification not found');

    const bools: Array<[string, string]> = [
      ['allow_forward', 'allowForward'],
      ['allow_download', 'allowDownload'],
      ['allow_print', 'allowPrint'],
      ['allow_export', 'allowExport'],
      ['allow_external', 'allowExternal'],
      ['require_approval', 'requireApproval'],
      ['require_encryption', 'requireEncryption'],
      ['is_active', 'isActive'],
    ];
    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    for (const [col, camel] of bools) {
      const v = b[camel] ?? b[col];
      if (v !== undefined) set(col, boolOf(v) ?? false);
    }
    if (b.label !== undefined) set('label', String(b.label));
    if (b.description !== undefined) set('description', b.description ?? null);
    if (b.color !== undefined) set('color', b.color ?? null);
    if (b.minRoleRank !== undefined || b.min_role_rank !== undefined)
      set('min_role_rank', NUM(b.minRoleRank ?? b.min_role_rank) ?? 1);
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    await c.query(
      `UPDATE email_classifications SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      params
    );
    await auditComms(c, ctx, 'MAIL_CLASSIFICATION_UPDATED', 'email_classification', id, {
      fields: sets.map((s) => s.split(' =')[0]),
    });
    const updated = await loadClassification(c, ctx.tenantId ?? 0, String(existing[0].code));
    return updated;
  })
);

/** Accept "mail.send,view" / ["VIEW","SEND"] / {view:true} delegation permission payloads. */
function parsePermissionTokens(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ['VIEW', 'SEND', 'REPLY'];
  if (typeof raw === 'string') return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => boolOf(v) === true)
      .map(([k]) => k);
  }
  return [];
}

﻿// ---------------------------------------------------------------------------
// Messages - list, summary, detail
// ---------------------------------------------------------------------------

/**
 * Scope predicate shared by every message query.
 *
 * A caller sees mail in mailboxes they hold access to, plus their own legacy
 * rows (mailbox_id IS NULL, created before mailboxes existed). Mail
 * administrators additionally audit every legacy row in the tenant.
 */
async function messageScope(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined
): Promise<{ clause: string; params: unknown[] }> {
  const params: unknown[] = [ctx.tenantId ?? 0];
  if (isMailAdmin(permissions)) return { clause: '', params };

  const mailboxIds = await accessibleMailboxIds(client, ctx, permissions);
  const userId = ctx.userId ?? 0;
  params.push(userId);
  const mine = `(e.created_by = $${params.length} OR e.sent_by = $${params.length})`;

  if (mailboxIds.length > 0) {
    params.push(mailboxIds);
    return {
      clause: `AND (e.mailbox_id = ANY($${params.length}::bigint[]) OR (e.mailbox_id IS NULL AND ${mine}))`,
      params,
    };
  }
  return { clause: `AND (e.mailbox_id IS NULL AND ${mine})`, params };
}

/** Columns the list projection returns - never the full body or the BCC list. */
const MESSAGE_LIST_COLUMNS = `
  e.id, e.mailbox_id, e.thread_id, e.direction, e.subject, e.status, e.folder,
  e.classification, e.priority, e.approval_state, e.is_read, e.is_starred,
  e.is_important, e.is_spam, e.has_attachments, e.scheduled_at, e.sent_at,
  e.created_at, e.updated_at, e.entity_type, e.entity_id, e.from_email,
  e.from_name, e.created_by, e.sent_by, e.on_behalf_of, e.version,
  e.provider_message_id, e.in_reply_to, e.deleted_at,
  LEFT(COALESCE(e.body, ''), 240) AS snippet`;

const MESSAGE_LIST_JOINS = `
  LEFT JOIN mailboxes mb ON mb.id = e.mailbox_id
  LEFT JOIN users cu ON cu.id = COALESCE(e.sent_by, e.created_by)`;

const MESSAGE_LIST_EXTRAS = `
  mb.code AS mailbox_code,
  mb.address AS mailbox_address,
  mb.display_name AS mailbox_name,
  NULLIF(TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')), '') AS owner_name,
  (SELECT count(*)::int FROM email_attachments a
    WHERE a.email_id = e.id AND a.deleted_at IS NULL) AS attachment_count,
  (SELECT count(*)::int FROM email_recipients r WHERE r.email_id = e.id) AS recipient_count`;

/** Folder counters for the workspace rails. Server-computed so they stay truthful. */
mailOpsRouter.get(
  '/messages/summary',
  ...runGet('communication.emails.view', async (c, ctx, q, _p, auth) => {
    const scope = await messageScope(c, ctx, auth?.permissions);
    const params = [...scope.params];
    const filters = ["e.tenant_id = $1", 'e.deleted_at IS NULL'];
    if (scope.clause) filters.push(scope.clause.replace(/^AND /, ''));

    const mailboxId = NUM(q.mailboxId);
    if (mailboxId !== null) {
      params.push(mailboxId);
      filters.push(`e.mailbox_id = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const { rows } = await c.query(
      `SELECT e.folder,
              count(*)::int AS total,
              count(*) FILTER (WHERE e.is_read = false)::int AS unread,
              count(*) FILTER (WHERE e.is_starred = true)::int AS starred,
              count(*) FILTER (WHERE e.approval_state = 'PENDING')::int AS pending_approval
         FROM emails e
        WHERE ${where}
        GROUP BY e.folder`,
      params
    );

    const folders: Record<string, { total: number; unread: number; starred: number; pendingApproval: number }> = {};
    for (const f of WORKSPACE_FOLDERS) folders[f] = { total: 0, unread: 0, starred: 0, pendingApproval: 0 };
    for (const r of rows) {
      const key = String(r.folder ?? 'INBOX');
      folders[key] = {
        total: Number(r.total ?? 0),
        unread: Number(r.unread ?? 0),
        starred: Number(r.starred ?? 0),
        pendingApproval: Number(r.pending_approval ?? 0),
      };
    }
    const mailboxes = await listMailboxesForUser(c, ctx, auth?.permissions);
    return { folders, mailboxCount: mailboxes.length };
  })
);

/** Server-side paged message list. Filtering and sorting never happen client-side. */
mailOpsRouter.get(
  '/messages',
  ...runGet('communication.emails.view', async (c, ctx, q, _p, auth) => {
    const { page, pageSize, offset } = parsePagination(q);
    const scope = await messageScope(c, ctx, auth?.permissions);
    const params = [...scope.params];
    const where: string[] = ['e.tenant_id = $1', 'e.deleted_at IS NULL'];
    if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));

    const add = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const folder = typeof q.folder === 'string' && q.folder.trim() ? String(q.folder).trim().toUpperCase() : null;
    if (folder) {
      if (!WORKSPACE_FOLDERS.includes(folder)) throw badRequest(`Unsupported folder "${folder}"`);
      where.push(`e.folder = $${add(folder)}`);
    } else {
      where.push("e.folder NOT IN ('TRASH', 'SPAM')");
    }

    const mailboxId = NUM(q.mailboxId);
    if (mailboxId !== null) where.push(`e.mailbox_id = $${add(mailboxId)}`);

    const classification = typeof q.classification === 'string' && q.classification.trim()
      ? String(q.classification).trim().toUpperCase()
      : null;
    if (classification) where.push(`e.classification = $${add(classification)}`);

    const priority = typeof q.priority === 'string' && q.priority.trim()
      ? String(q.priority).trim().toUpperCase()
      : null;
    if (priority) where.push(`e.priority = $${add(priority)}`);

    const status = typeof q.status === 'string' && q.status.trim()
      ? String(q.status).trim().toUpperCase()
      : null;
    if (status) where.push(`e.status = $${add(status)}`);

    for (const [key, column] of [
      ['isRead', 'e.is_read'],
      ['isStarred', 'e.is_starred'],
      ['isImportant', 'e.is_important'],
      ['hasAttachments', 'e.has_attachments'],
    ] as const) {
      const v = boolOf(q[key]);
      if (v !== null) where.push(`${column} = $${add(v)}`);
    }

    if (typeof q.entityType === 'string' && q.entityType.trim()) {
      where.push(`e.entity_type = $${add(String(q.entityType).trim().toUpperCase())}`);
    }
    const entityId = NUM(q.entityId);
    if (entityId !== null) where.push(`e.entity_id = $${add(entityId)}`);

    const dateColumn = folder === 'SCHEDULED' ? 'e.scheduled_at' : 'e.created_at';
    if (typeof q.dateFrom === 'string' && q.dateFrom.trim()) {
      where.push(`${dateColumn} >= $${add(q.dateFrom.trim())}`);
    }
    if (typeof q.dateTo === 'string' && q.dateTo.trim()) {
      where.push(`${dateColumn} <= $${add(q.dateTo.trim())}`);
    }

    const term = typeof q.q === 'string' ? q.q.trim() : '';
    if (term) {
      const i = add(`%${term}%`);
      where.push(
        `(e.subject ILIKE $${i} OR e.body ILIKE $${i} OR e.from_email ILIKE $${i}` +
          ` OR e.from_name ILIKE $${i}` +
          ` OR EXISTS (SELECT 1 FROM email_recipients r WHERE r.email_id = e.id` +
          ` AND (r.email ILIKE $${i} OR r.name ILIKE $${i})))`
      );
    }

    const sortRaw = typeof q.sort === 'string' ? q.sort.trim() : '';
    const sort = SORTABLE.has(sortRaw) ? sortRaw : 'created_at';
    const order = String(q.order ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const clause = `WHERE ${where.join(' AND ')}`;
    const { rows } = await c.query(
      `SELECT ${MESSAGE_LIST_COLUMNS}, ${MESSAGE_LIST_EXTRAS}, COUNT(*) OVER() AS _total
         FROM emails e
         ${MESSAGE_LIST_JOINS}
         ${clause}
        ORDER BY e.${sort} ${order} NULLS LAST, e.id DESC
        LIMIT $${add(pageSize)} OFFSET $${add(offset)}`,
      params
    );

    const total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;
    const data = toCamelRows(rows.map(stripTotal));
    return { rows: data, pagination: { page, pageSize, total } };
  })
);

/** Full message: body, recipients, attachments, labels, workflow, delivery, audit. */
mailOpsRouter.get(
  '/messages/:id',
  ...runGet('communication.emails.view', async (c, ctx, _q, p, auth) => {
    const id = idOf(p.id, 'message id');
    const { email, access, classification } = await loadForRead(c, ctx, auth?.permissions, id);

    const [recipients, attachments, labels, approvals, deliveries, audit, thread] = await Promise.all([
      c.query(
        `SELECT id, kind, email, name, status, provider_message_id, error, sent_at, read_at, created_at
           FROM email_recipients WHERE email_id = $1 ORDER BY kind, id`,
        [id]
      ),
      c.query(
        `SELECT a.id, a.file_name, a.file_type, a.file_size, a.source, a.scan_status,
                a.dms_document_id, a.entity_type, a.entity_id, a.content_hash,
                a.uploaded_by, a.is_inline, a.created_at,
                u.first_name AS uploader_first_name, u.last_name AS uploader_last_name
           FROM email_attachments a
           LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.email_id = $1 AND a.deleted_at IS NULL
          ORDER BY a.id`,
        [id]
      ),
      c.query(
        `SELECT l.id, l.name, l.color
           FROM email_message_labels ml
           JOIN email_labels l ON l.id = ml.label_id
          WHERE ml.email_id = $1
          ORDER BY l.name`,
        [id]
      ),
      listEmailApprovals(c, ctx, id),
      listDeliveryEvents(c, ctx.tenantId ?? 0, id),
      c.query(
        `SELECT id, user_id, action, detail, mailbox_id, message_id, device, result, ip, created_at
           FROM communication_audit_logs
          WHERE tenant_id = $1 AND ((target_type = 'email' AND target_id = $2) OR message_id = $3)
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
        [ctx.tenantId ?? 0, id, String(id)]
      ),
      email.thread_id
        ? c.query(
            `SELECT id, subject, message_count, unread_count, last_direction, last_message_at
               FROM email_threads WHERE id = $1 AND tenant_id = $2`,
            [email.thread_id, ctx.tenantId ?? 0]
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);

    // Policy answers for the action bar: a non-null string is the reason the
    // action is unavailable, so the UI can explain instead of hiding silently.
    const policy = {
      forward: classificationBlockReason(classification, 'FORWARD'),
      download: classificationBlockReason(classification, 'DOWNLOAD'),
      print: classificationBlockReason(classification, 'PRINT'),
      export: classificationBlockReason(classification, 'EXPORT'),
    };
    const mailboxPermissions = access
      ? {
          canView: access.canView,
          canSend: access.canSend,
          canReply: access.canReply,
          canDelete: access.canDelete,
          canArchive: access.canArchive,
          canDelegate: access.canDelegate,
          canExport: access.canExport,
          canAdmin: access.canAdmin,
        }
      : { canView: true, canSend: true, canReply: true, canDelete: true, canArchive: true, canDelegate: false, canExport: false, canAdmin: false };

    return {
      message: toCamelRow(email),
      mailbox: access ? mailboxView(access) : null,
      mailboxPermissions,
      classification,
      policy,
      confirmedDeliveryStatus: confirmedStatus(deliveries),
      recipients: toCamelRows(recipients.rows),
      attachments: toCamelRows(attachments.rows),
      labels: toCamelRows(labels.rows),
      approvals,
      deliveryEvents: deliveries,
      thread: thread.rows.length > 0 ? toCamelRow(thread.rows[0]) : null,
      audit: toCamelRows(audit.rows),
    };
  })
);

// ---------------------------------------------------------------------------
// Messages - state transitions
// ---------------------------------------------------------------------------

/** Flags a message the caller may mutate (read/star/important/spam/priority). */
mailOpsRouter.patch(
  '/messages/:id',
  ...run('communication.emails.manage', async (c, ctx, b, p, auth) => {
    const id = idOf(p.id, 'message id');
    const { email, access } = await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      id,
      'canView',
      'You do not have permission to change this message'
    );

    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    const read = boolOf(b.isRead ?? b.is_read);
    if (read !== null) {
      set('is_read', read);
      sets.push(`read_at = ${read ? 'now()' : 'NULL'}`);
    }
    const starred = boolOf(b.isStarred ?? b.is_starred);
    if (starred !== null) set('is_starred', starred);
    const important = boolOf(b.isImportant ?? b.is_important);
    if (important !== null) set('is_important', important);
    const spam = boolOf(b.isSpam ?? b.is_spam);
    if (spam !== null) {
      set('is_spam', spam);
      set('folder', spam ? 'SPAM' : 'INBOX');
    }
    if (b.priority !== undefined) {
      const priority = String(b.priority).toUpperCase();
      if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
        throw badRequest('priority must be LOW, NORMAL, HIGH or URGENT');
      }
      set('priority', priority);
    }
    if (b.classification !== undefined) {
      const code = String(b.classification).toUpperCase();
      const next = await loadClassification(c, ctx.tenantId ?? 0, code);
      if (!next) throw badRequest(`Unknown classification "${code}"`);
      if (email.approval_state === 'APPROVED' && next.requireApproval) {
        // Raising the classification after approval invalidates the approval.
        set('approval_state', 'RETURNED');
      }
      set('classification', next.code);
    }
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    await c.query(
      `UPDATE emails SET ${sets.join(', ')}, version = version + 1, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      params
    );
    await auditMail(c, ctx, 'EMAIL_UPDATED', 'email', id, {
      fields: sets.map((s) => s.split(' =')[0]),
    }, access ? access.mailboxId : null);

    const { rows } = await c.query(`SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`, [id, ctx.tenantId ?? 0]);
    return { message: toCamelRow(rows[0]) };
  })
);

/** Shared implementation for the single-target folder moves. */
async function moveMessage(
  c: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  emailId: number,
  folder: string,
  flag: Parameters<typeof assertMailboxPermission>[1]
): Promise<Record<string, unknown>> {
  const { access } = await loadForWrite(
    c,
    ctx,
    permissions,
    emailId,
    flag,
    `You do not have permission to move this message`
  );
  const archivedAt = folder === 'ARCHIVE' ? 'now()' : 'NULL';
  await c.query(
    `UPDATE emails
        SET folder = $3, archived_at = ${archivedAt}, updated_at = now(), version = version + 1
      WHERE id = $1 AND tenant_id = $2`,
    [emailId, ctx.tenantId ?? 0, folder]
  );
  await auditMail(c, ctx, 'EMAIL_FOLDER_CHANGED', 'email', emailId, { folder }, access ? access.mailboxId : null);
  return { id: emailId, folder };
}

mailOpsRouter.post(
  '/messages/:id/archive',
  ...run('communication.emails.manage', async (c, ctx, _b, p, auth) =>
    moveMessage(c, ctx, auth?.permissions, idOf(p.id, 'message id'), 'ARCHIVE', 'canArchive')
  )
);

mailOpsRouter.post(
  '/messages/:id/unarchive',
  ...run('communication.emails.manage', async (c, ctx, _b, p, auth) =>
    moveMessage(c, ctx, auth?.permissions, idOf(p.id, 'message id'), 'INBOX', 'canArchive')
  )
);

mailOpsRouter.post(
  '/messages/:id/restore',
  ...run('communication.emails.manage', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'message id');
    const { access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canArchive', 'You do not have permission to restore this message'
    );
    await c.query(
      `UPDATE emails SET folder = 'INBOX', deleted_at = NULL, archived_at = NULL,
              updated_at = now(), version = version + 1
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    await auditMail(c, ctx, 'EMAIL_RESTORED', 'email', id, {}, access ? access.mailboxId : null);
    return { id, folder: 'INBOX', restored: true };
  })
);

/** Explicit move. Both the source and the destination mailbox are authorised. */
mailOpsRouter.post(
  '/messages/:id/move',
  ...run('communication.emails.manage', async (c, ctx, b, p, auth) => {
    const id = idOf(p.id, 'message id');
    const folder = String(b.folder ?? '').trim().toUpperCase();
    if (!WORKSPACE_FOLDERS.includes(folder)) throw badRequest('A valid destination folder is required');
    const { email, access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canArchive', 'You do not have permission to move this message'
    );

    let targetMailboxId: number | null = null;
    if (b.mailboxId !== undefined && b.mailboxId !== null && b.mailboxId !== '') {
      targetMailboxId = idOf(b.mailboxId, 'mailbox id');
      // Moving mail between mailboxes needs access to the destination too.
      const target = await resolveMailboxAccess(c, ctx, auth?.permissions, targetMailboxId);
      assertMailboxPermission(target, 'canView', 'You do not have access to the destination mailbox');
    }

    await c.query(
      `UPDATE emails
          SET folder = $3, mailbox_id = COALESCE($4, mailbox_id),
              archived_at = CASE WHEN $3 = 'ARCHIVE' THEN now() ELSE NULL END,
              deleted_at = NULL, updated_at = now(), version = version + 1
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0, folder, targetMailboxId]
    );
    await auditMail(c, ctx, 'EMAIL_MOVED', 'email', id, {
      folder,
      fromMailboxId: email.mailbox_id === null ? null : Number(email.mailbox_id),
      toMailboxId: targetMailboxId,
    }, access ? access.mailboxId : null);
    return { id, folder, mailboxId: targetMailboxId ?? (email.mailbox_id === null ? null : Number(email.mailbox_id)) };
  })
);

/** Move to trash. Recoverable until it is purged. */
mailOpsRouter.delete(
  '/messages/:id',
  ...run('communication.emails.manage', async (c, ctx, _b, p, auth) =>
    moveMessage(c, ctx, auth?.permissions, idOf(p.id, 'message id'), 'TRASH', 'canDelete')
  )
);

/**
 * Permanent removal. Only a message already sitting in the trash can be purged,
 * so a stray id can never destroy a live conversation. The audit entry is
 * written first: communication_audit_logs carries no foreign key to emails, so
 * the trail outlives the row it describes.
 */
mailOpsRouter.post(
  '/messages/:id/purge',
  ...run('communication.emails.manage', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'message id');
    const { access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canDelete', 'You do not have permission to delete this message'
    );
    const { rows } = await c.query(
      `SELECT folder, subject FROM emails WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    const row = rows[0];
    if (!row) throw notFound('Message not found');
    if (row.folder !== 'TRASH') {
      throw conflict('Only messages already in the trash can be permanently deleted.');
    }
    await auditMail(
      c, ctx, 'EMAIL_PURGED', 'email', id,
      { subject: row.subject, folder: row.folder }, access ? access.mailboxId : null
    );
    await c.query(`DELETE FROM emails WHERE id = $1 AND tenant_id = $2`, [id, ctx.tenantId ?? 0]);
    return { id, deleted: true };
  })
);

// ---------------------------------------------------------------------------
// Drafts - compose, edit
// ---------------------------------------------------------------------------

/**
 * Recipients live in two places on purpose. `email_recipients` rows drive the
 * queries and the delivery trail, while the legacy to/cc/bcc jsonb is what
 * sendStoredEmail() falls back to when no rows exist. Both must move together
 * or the composer and the sender disagree about who is being written to.
 */
async function syncRecipients(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number,
  lists: { to: string[]; cc: string[]; bcc: string[] }
): Promise<number> {
  await client.query(
    `DELETE FROM email_recipients WHERE email_id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
  let count = 0;
  for (const [kind, list] of [['TO', lists.to], ['CC', lists.cc], ['BCC', lists.bcc]] as const) {
    for (const address of list) {
      await client.query(
        `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status)
         VALUES ($1, $2, $3, $4, 'QUEUED')`,
        [tenantId, emailId, kind, address]
      );
      count += 1;
    }
  }
  await client.query(
    `UPDATE emails SET "to" = $2::jsonb, cc = $3::jsonb, bcc = $4::jsonb
      WHERE id = $1 AND tenant_id = $5`,
    [emailId, JSON.stringify(lists.to), JSON.stringify(lists.cc), JSON.stringify(lists.bcc), tenantId]
  );
  return count;
}

const MAIL_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function priorityOf(raw: unknown): string {
  const value = String(raw ?? 'NORMAL').trim().toUpperCase();
  if (!MAIL_PRIORITIES.includes(value)) throw badRequest(`Unsupported priority "${value}"`);
  return value;
}

/**
 * The mailbox a caller composes from. No mailbox means a personal draft, which
 * stays readable only to its author - the same rule legacy rows already follow.
 */
async function composingMailbox(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  rawMailboxId: unknown,
  flag: Parameters<typeof assertMailboxPermission>[1] = 'canView'
): Promise<MailboxAccess | null> {
  const mailboxId = NUM(rawMailboxId);
  if (mailboxId === null) return null;
  const access = await resolveMailboxAccess(client, ctx, permissions, mailboxId);
  assertMailboxPermission(access, flag, 'You do not have access to this mailbox');
  return access;
}

/** Refuse an edit built on a copy of the row that is no longer current. */
function assertVersion(email: Record<string, unknown>, expected: number | null): void {
  if (expected === null) return;
  if (Number(email.version ?? 1) !== expected) {
    throw conflict('This message changed while you were editing it. Reload it and reapply your changes.');
  }
}

/**
 * Authoring-time classification guard.
 *
 * A classification's reader-side rules (forward/download/print/export) only
 * become meaningful once a row exists, so a new or edited draft is judged on
 * the one rule that can be evaluated up front: a classification barred from
 * external delivery must not be addressed outside the organisation. Enforcing
 * it while the author is still composing tells them immediately, instead of
 * letting them finish and then refusing the send.
 */
async function assertCreationAllowed(
  c: pg.PoolClient,
  ctx: Ctx,
  classification: MailClassification,
  recipients: readonly string[]
): Promise<void> {
  if (classification.allowExternal) return;
  if (recipients.length === 0) return;
  const domains = await tenantMailDomains(c, ctx.tenantId ?? 0);
  if (hasExternalRecipient(recipients, domains)) {
    throw forbidden(
      `Messages classified ${classification.label} cannot be addressed outside the organisation.`
    );
  }
}

/** Create the draft that the composer then edits and sends. */
mailOpsRouter.post(
  '/messages',
  ...run('communication.mail_drafts.create', async (c, ctx, body, _p, auth) => {
    const tenantId = ctx.tenantId ?? 0;
    const access = await composingMailbox(c, ctx, auth?.permissions, body.mailboxId);

    const to = parseAddressList(body.to);
    const cc = parseAddressList(body.cc);
    const bcc = parseAddressList(body.bcc);

    const classification = await loadClassification(
      c,
      tenantId,
      String(body.classification ?? access?.mailbox?.default_classification ?? 'INTERNAL')
    );
    await assertCreationAllowed(c, ctx, classification, [...to, ...cc, ...bcc]);

    const signatureId = NUM(body.signatureId);
    if (signatureId !== null) {
      await resolveSignature(c, ctx, signatureId, access ? access.mailboxId : null);
    }

    const { rows } = await c.query(
      `INSERT INTO emails
         (tenant_id, company_id, branch_id, direction, subject, body, body_html,
          "to", cc, bcc, status, folder, classification, priority, signature_id,
          mailbox_id, from_email, from_name, reply_to, entity_type, entity_id,
          template_code, created_by, source_ip)
       VALUES ($1,$2,$3,'OUT',$4,$5,$6,
               $7::jsonb,$8::jsonb,$9::jsonb,'DRAFT','DRAFTS',$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, version, status, folder, created_at`,
      [
        tenantId, ctx.companyId ?? null, ctx.branchId ?? null,
        String(body.subject ?? '').slice(0, 500),
        body.body === undefined || body.body === null ? null : String(body.body),
        body.html === undefined || body.html === null ? null : String(body.html),
        JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc),
        classification.code, priorityOf(body.priority), signatureId,
        access ? access.mailboxId : null,
        access?.mailbox?.address ?? null,
        access?.mailbox?.default_sender_name ?? null,
        body.replyTo ? String(body.replyTo) : null,
        body.entityType ? String(body.entityType).toUpperCase() : null,
        NUM(body.entityId),
        body.templateCode ? String(body.templateCode) : null,
        ctx.userId ?? null, ctx.ip ?? null,
      ]
    );
    const id = Number(rows[0].id);
    const recipientCount = await syncRecipients(c, tenantId, id, { to, cc, bcc });
    await auditMail(c, ctx, 'EMAIL_DRAFT_CREATED', 'email', id, {
      mailboxId: access ? access.mailboxId : null,
      classification: classification.code,
      recipientCount,
    }, access ? access.mailboxId : null);
    return {
      id,
      version: Number(rows[0].version ?? 1),
      status: 'DRAFT',
      folder: 'DRAFTS',
      recipientCount,
    };
  })
);

/** Update a draft. Sent messages are immutable here - reply or forward instead. */
mailOpsRouter.patch(
  '/messages/:id/draft',
  ...run('communication.mail_drafts.update', async (c, ctx, body, p, auth) => {
    const id = idOf(p.id, 'message id');
    const tenantId = ctx.tenantId ?? 0;
    const { email, access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canView', 'You do not have permission to edit this message'
    );

    const status = String(email.status ?? '');
    if (status === 'SENT' || status === 'QUEUED' || status === 'SENDING') {
      throw conflict('Sent messages are immutable. Reply or forward instead.');
    }
    assertVersion(email, NUM(body.expectedVersion ?? body.version));

    const sets: string[] = [];
    const params: unknown[] = [id, tenantId];
    const add = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    if (body.subject !== undefined) sets.push(`subject = $${add(String(body.subject ?? '').slice(0, 500))}`);
    if (body.body !== undefined) sets.push(`body = $${add(body.body === null ? null : String(body.body))}`);
    if (body.html !== undefined) sets.push(`body_html = $${add(body.html === null ? null : String(body.html))}`);
    if (body.priority !== undefined) sets.push(`priority = $${add(priorityOf(body.priority))}`);
    if (body.replyTo !== undefined) sets.push(`reply_to = $${add(body.replyTo ? String(body.replyTo) : null)}`);
    if (body.templateCode !== undefined) sets.push(`template_code = $${add(body.templateCode ? String(body.templateCode) : null)}`);
    if (body.entityType !== undefined) sets.push(`entity_type = $${add(body.entityType ? String(body.entityType).toUpperCase() : null)}`);
    if (body.entityId !== undefined) sets.push(`entity_id = $${add(NUM(body.entityId))}`);

    if (body.classification !== undefined) {
      const classification = await loadClassification(c, tenantId, String(body.classification));
      // Judge the classification against the recipients the draft will actually
      // carry, so an edit that leaves recipients untouched is still checked
      // against the addresses already stored on the row.
      await assertCreationAllowed(c, ctx, classification, [
        ...parseAddressList(body.to !== undefined ? body.to : email.to),
        ...parseAddressList(body.cc !== undefined ? body.cc : email.cc),
        ...parseAddressList(body.bcc !== undefined ? body.bcc : email.bcc),
      ]);
      sets.push(`classification = $${add(classification.code)}`);
    }
    if (body.signatureId !== undefined) {
      const signatureId = NUM(body.signatureId);
      if (signatureId !== null) {
        await resolveSignature(c, ctx, signatureId, access ? access.mailboxId : null);
      }
      sets.push(`signature_id = $${add(signatureId)}`);
    }
    if (body.mailboxId !== undefined) {
      const target = await composingMailbox(c, ctx, auth?.permissions, body.mailboxId);
      sets.push(`mailbox_id = $${add(target ? target.mailboxId : null)}`);
    }
    if (body.scheduledAt !== undefined) {
      const when = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
      if (when && Number.isNaN(when.getTime())) throw badRequest('Invalid scheduled time');
      sets.push(`scheduled_at = $${add(when)}`);
    }

    // Editing a returned message hands it back to the author.
    if (status === 'PENDING_APPROVAL') sets.push(`approval_state = 'NOT_REQUIRED'`);

    let recipientCount: number | null = null;
    if (body.to !== undefined || body.cc !== undefined || body.bcc !== undefined) {
      const to = body.to !== undefined ? parseAddressList(body.to) : parseAddressList(email.to);
      const cc = body.cc !== undefined ? parseAddressList(body.cc) : parseAddressList(email.cc);
      const bcc = body.bcc !== undefined ? parseAddressList(body.bcc) : parseAddressList(email.bcc);
      recipientCount = await syncRecipients(c, tenantId, id, { to, cc, bcc });
    }

    sets.push('updated_at = now()', 'version = version + 1');
    const { rows } = await c.query(
      `UPDATE emails SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, version, status, folder, updated_at`,
      params
    );

    await auditMail(c, ctx, 'EMAIL_DRAFT_UPDATED', 'email', id, {
      fields: sets.map((s) => s.split(' =')[0]),
      recipientCount,
    }, access ? access.mailboxId : null);

    return { ...toCamelRow(rows[0]), recipientCount };
  })
);

// ---------------------------------------------------------------------------
// Sending - schedule, dispatch, outbox
// ---------------------------------------------------------------------------

/**
 * Dispatch a stored message. sendStoredEmail() owns the approval gate, the
 * recipient policy and the outbox write; the route only persists the send
 * intent first so a provider failure leaves a retryable row behind.
 */
mailOpsRouter.post(
  '/messages/:id/send',
  messagingLimiter,
  ...run('communication.emails.send', async (c, ctx, body, p, auth) => {
    const id = idOf(p.id, 'message id');
    const tenantId = ctx.tenantId ?? 0;
    await loadForWrite(
      c, ctx, auth?.permissions, id, 'canSend', 'You do not have permission to send from this mailbox'
    );

    if (body.to !== undefined || body.cc !== undefined || body.bcc !== undefined) {
      const current = await c.query(
        `SELECT "to" AS to_list, cc, bcc FROM emails WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      const row = (current.rows[0] ?? {}) as Record<string, unknown>;
      await syncRecipients(c, tenantId, id, {
        to: body.to !== undefined ? parseAddressList(body.to) : parseAddressList(row.to_list),
        cc: body.cc !== undefined ? parseAddressList(body.cc) : parseAddressList(row.cc),
        bcc: body.bcc !== undefined ? parseAddressList(body.bcc) : parseAddressList(row.bcc),
      });
    }

    const scheduledAt = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
    if (scheduledAt) {
      if (Number.isNaN(scheduledAt.getTime())) throw badRequest('Invalid scheduled time');
      await c.query(
        `UPDATE emails SET scheduled_at = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId, scheduledAt]
      );
    }

    return sendStoredEmail(c, ctx, auth?.permissions, id, {
      mailboxId: NUM(body.mailboxId) ?? undefined,
      signatureId: NUM(body.signatureId) ?? undefined,
      html: body.html === undefined || body.html === null ? undefined : String(body.html),
      forceNow: boolOf(body.forceNow) === true,
      release: body.approvalId ? { approvalId: idOf(body.approvalId, 'approval id') } : undefined,
    });
  })
);

/** Park a draft until a future time. emailQueueFlush() performs the send. */
mailOpsRouter.post(
  '/messages/:id/schedule',
  ...run('communication.mail_scheduled.create', async (c, ctx, body, p, auth) => {
    const id = idOf(p.id, 'message id');
    const tenantId = ctx.tenantId ?? 0;
    const { email, access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canSend', 'You do not have permission to schedule this message'
    );

    const when = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
    if (!when || Number.isNaN(when.getTime())) throw badRequest('A scheduled time is required');
    if (when.getTime() <= Date.now()) throw badRequest('The scheduled time must be in the future');

    const status = String(email.status ?? '');
    if (!['DRAFT', 'SCHEDULED', 'FAILED', 'PENDING_APPROVAL'].includes(status)) {
      throw conflict('This message is already on its way and cannot be rescheduled.');
    }

    const { rows } = await c.query(
      `UPDATE emails SET scheduled_at = $3, status = 'SCHEDULED', folder = 'SCHEDULED',
              updated_at = now(), version = version + 1
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, version, status, folder, scheduled_at`,
      [id, tenantId, when]
    );
    await auditMail(c, ctx, 'EMAIL_SCHEDULED', 'email', id, {
      scheduledAt: when.toISOString(),
    }, access ? access.mailboxId : null);
    return toCamelRow(rows[0]);
  })
);

/** Return a scheduled message to the author's drafts. */
mailOpsRouter.post(
  '/messages/:id/unschedule',
  ...run('communication.mail_scheduled.cancel', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'message id');
    const tenantId = ctx.tenantId ?? 0;
    const { email, access } = await loadForWrite(
      c, ctx, auth?.permissions, id, 'canSend', 'You do not have permission to reschedule this message'
    );
    if (String(email.status ?? '') !== 'SCHEDULED') throw conflict('This message is not scheduled.');

    const { rows } = await c.query(
      `UPDATE emails SET scheduled_at = NULL, status = 'DRAFT', folder = 'DRAFTS',
              updated_at = now(), version = version + 1
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, version, status, folder`,
      [id, tenantId]
    );
    await auditMail(c, ctx, 'EMAIL_SCHEDULE_CANCELLED', 'email', id, {}, access ? access.mailboxId : null);
    return toCamelRow(rows[0]);
  })
);

/** Queued, scheduled and failed sends. Scope-scoped like every other list. */
mailOpsRouter.get(
  '/outbox',
  ...runGet('communication.mail_scheduler.view', async (c, ctx, q, _p, auth) => {
    const { page, pageSize, offset } = parsePagination(q);
    const scope = await messageScope(c, ctx, auth?.permissions);
    const params = [...scope.params];
    const where: string[] = ['o.tenant_id = $1'];
    if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));

    const add = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const status = typeof q.status === 'string' && q.status.trim()
      ? String(q.status).trim().toUpperCase()
      : null;
    if (status) where.push(`o.status = $${add(status)}`);

    const { rows } = await c.query(
      `SELECT o.id, o.email_id, o.mailbox_id, o.status, o.attempts, o.max_attempts,
              o.next_attempt_at, o.last_error, o.provider, o.provider_message_id,
              o.queued_at, o.sent_at,
              e.subject, e.status AS email_status, e.folder, e.priority,
              e.classification, e.scheduled_at, e.updated_at,
              COUNT(*) OVER() AS _total
         FROM email_outbox o
         JOIN emails e ON e.id = o.email_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.queued_at DESC, o.id DESC
        LIMIT $${add(pageSize)} OFFSET $${add(offset)}`,
      params
    );

    const total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;
    return { rows: toCamelRows(rows.map(stripTotal)), pagination: { page, pageSize, total } };
  })
);

/** Re-attempt a failed send. The attempt ceiling is enforced, never bypassed. */
mailOpsRouter.post(
  '/outbox/:id/retry',
  ...run('communication.mail_scheduler.manage', async (c, ctx, body, p, auth) => {
    const outboxId = idOf(p.id, 'outbox id');
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT id, email_id, attempts, max_attempts, status
         FROM email_outbox WHERE id = $1 AND tenant_id = $2`,
      [outboxId, tenantId]
    );
    if (rows.length === 0) throw notFound('Outbox entry not found');
    const entry = rows[0] as Record<string, unknown>;
    const attempts = Number(entry.attempts ?? 0);
    const maxAttempts = Number(entry.max_attempts ?? 3);
    if (attempts >= maxAttempts) {
      throw conflict(
        `This message has already been attempted ${attempts} time(s) and reached its limit of ${maxAttempts}.`
      );
    }

    const emailId = Number(entry.email_id);
    await loadForWrite(
      c, ctx, auth?.permissions, emailId, 'canSend', 'You do not have permission to send this message'
    );
    await auditMail(c, ctx, 'EMAIL_OUTBOX_RETRY', 'email', emailId, { outboxId, attempts });

    return sendStoredEmail(c, ctx, auth?.permissions, emailId, {
      forceNow: true,
      mailboxId: NUM(body?.mailboxId) ?? undefined,
    });
  })
);
// ---------------------------------------------------------------------------
// Message approvals (multi-level; segregation of duties is enforced server-side)
// ---------------------------------------------------------------------------

/**
 * Submit a draft for approval. Only the author may submit, the message must
 * still be editable, and the approval ladder is derived by the service - the
 * route only proves the caller may send from the owning mailbox, because
 * submitForApproval() does not resolve mailbox scope itself.
 */
mailOpsRouter.post(
  '/messages/:id/approvals',
  ...run('communication.mail_approvals.submit', async (c, ctx, b, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      emailId,
      'canSend',
      'You do not have permission to send this message'
    );
    const rawReason = b.reason ?? b.justification ?? null;
    return submitForApproval(c, ctx, emailId, {
      approverRole: b.approverRole ?? b.approver_role ?? null,
      approverUserId: NUM(b.approverUserId ?? b.approver_user_id),
      reason: rawReason === null || rawReason === undefined ? null : String(rawReason),
    });
  })
);

/** Full approval history for one message. Scoped through loadForRead(). */
mailOpsRouter.get(
  '/messages/:id/approvals',
  ...runGet('communication.mail_approvals.view', async (c, ctx, _q, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    await loadForRead(c, ctx, auth?.permissions, emailId);
    return { approvals: await listEmailApprovals(c, ctx, emailId) };
  })
);

/**
 * The caller's decision queue. Rows the caller cannot yet decide are returned
 * annotated with blockedReason instead of being hidden or offered as a button
 * that would fail with 403.
 */
mailOpsRouter.get(
  '/approvals',
  ...runGet('communication.mail_approvals.view', async (c, ctx, q, _p, auth) => {
    const approvals = await listPendingApprovals(c, ctx, auth?.permissions, {
      emailId: NUM(q.emailId ?? q.email_id) ?? undefined,
      limit: NUM(q.limit) ?? undefined,
    });
    return { approvals, actionableCount: approvals.filter((a) => a.actionable).length };
  })
);

/** Accept decisionNote / decision_note / note from the client. */
function decisionNoteOf(b: Record<string, unknown>): string {
  const raw = b.decisionNote ?? b.decision_note ?? b.note;
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

mailOpsRouter.post(
  '/approvals/:id/approve',
  ...run('communication.mail_approvals.approve', async (c, ctx, b, p, auth) => {
    const approvalId = idOf(p.id, 'approval id');
    const note = decisionNoteOf(b);
    return approveEmail(c, ctx, auth?.permissions, approvalId, note.length > 0 ? note : null);
  })
);

mailOpsRouter.post(
  '/approvals/:id/reject',
  ...run('communication.mail_approvals.reject', async (c, ctx, b, p, auth) => {
    const approvalId = idOf(p.id, 'approval id');
    const note = decisionNoteOf(b);
    if (note.length === 0) throw badRequest('A reason is required to reject a message.');
    return rejectEmail(c, ctx, auth?.permissions, approvalId, note);
  })
);

mailOpsRouter.post(
  '/approvals/:id/return',
  ...run('communication.mail_approvals.reject', async (c, ctx, b, p, auth) => {
    const approvalId = idOf(p.id, 'approval id');
    const note = decisionNoteOf(b);
    if (note.length === 0) throw badRequest('A note is required to return a message for changes.');
    return returnEmail(c, ctx, auth?.permissions, approvalId, note);
  })
);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * A signature is either personal (owned by the caller) or shared with one
 * mailbox. Only the owner, or a mailbox administrator for a shared signature,
 * may change it.
 */
async function loadSignatureForWrite(
  c: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  signatureId: number
): Promise<Record<string, unknown>> {
  const { rows } = await c.query(
    `SELECT * FROM email_signatures WHERE id = $1 AND tenant_id = $2`,
    [signatureId, ctx.tenantId ?? 0]
  );
  if (rows.length === 0) throw notFound('Signature not found');
  const row = rows[0] as Record<string, unknown>;
  if (Number(row.user_id) === (ctx.userId ?? 0)) return row;
  if (row.is_shared === true && row.mailbox_id !== null) {
    const access = await resolveMailboxAccess(c, ctx, permissions, Number(row.mailbox_id));
    assertMailboxPermission(
      access,
      'canAdmin',
      'You do not have permission to manage shared signatures for this mailbox'
    );
    return row;
  }
  throw forbidden('You may not change a signature you do not own.');
}

/** Keep "at most one default" true across the caller's usable signature set. */
async function clearOtherDefaultSignatures(
  c: pg.PoolClient,
  ctx: Ctx,
  keepId: number,
  mailboxId: number | null
): Promise<void> {
  await c.query(
    `UPDATE email_signatures
        SET is_default = false, updated_at = now()
      WHERE tenant_id = $1
        AND id <> $2
        AND is_default = true
        AND (user_id = $3 OR ($4::bigint IS NOT NULL AND is_shared = true AND mailbox_id = $4))`,
    [ctx.tenantId ?? 0, keepId, ctx.userId ?? 0, mailboxId]
  );
}

mailOpsRouter.get(
  '/signatures',
  ...runGet('communication.mail_signatures.view', async (c, ctx, q, _p) => {
    const mailboxId = NUM(q.mailboxId ?? q.mailbox_id);
    const signatures = await listUsableSignatures(c, ctx, mailboxId);
    return { signatures, defaultSignature: await defaultSignature(c, ctx, mailboxId) };
  })
);

mailOpsRouter.post(
  '/signatures',
  ...run('communication.mail_signatures.create', async (c, ctx, b, _p, auth) => {
    const name = String(b.name ?? '').trim();
    if (name.length === 0) throw badRequest('A signature name is required.');
    const mailboxId = NUM(b.mailboxId ?? b.mailbox_id);
    const isShared = boolOf(b.isShared ?? b.is_shared) ?? false;
    const isDefault = boolOf(b.isDefault ?? b.is_default) ?? false;
    if (isShared) {
      if (mailboxId === null) throw badRequest('A shared signature must be scoped to a mailbox.');
      const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
      assertMailboxPermission(
        access,
        'canAdmin',
        'You do not have permission to manage shared signatures for this mailbox'
      );
    } else if (mailboxId !== null) {
      const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
      assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    }

    const { rows } = await c.query(
      `INSERT INTO email_signatures
         (tenant_id, user_id, mailbox_id, name, body_text, body_html, logo_path, job_title,
          department, phone, website, social, disclaimer, is_default, is_shared, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,true,$16)
       RETURNING *`,
      [
        ctx.tenantId ?? 0,
        ctx.userId ?? null,
        mailboxId,
        name,
        b.bodyText ?? b.body_text ?? null,
        b.bodyHtml ?? b.body_html ?? null,
        b.logoPath ?? b.logo_path ?? null,
        b.jobTitle ?? b.job_title ?? null,
        b.department ?? null,
        b.phone ?? null,
        b.website ?? null,
        JSON.stringify(b.social && typeof b.social === 'object' ? b.social : {}),
        b.disclaimer ?? null,
        isDefault,
        isShared,
        ctx.userId ?? null,
      ]
    );
    const signature = toSignature(rows[0]);
    if (isDefault) await clearOtherDefaultSignatures(c, ctx, signature.id, mailboxId);
    await auditMail(c, ctx, 'MAIL_SIGNATURE_CREATED', 'email_signature', signature.id, {
      name,
      mailboxId,
      isShared,
      isDefault,
    });
    return { signature };
  })
);

mailOpsRouter.patch(
  '/signatures/:id',
  ...run('communication.mail_signatures.update', async (c, ctx, b, p, auth) => {
    const id = idOf(p.id, 'signature id');
    const existing = await loadSignatureForWrite(c, ctx, auth?.permissions, id);
    const mailboxId = mailboxIdOf(existing);

    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length === 0) throw badRequest('A signature name is required.');
      set('name', name);
    }
    const textFields: Array<[string, string]> = [
      ['body_text', 'bodyText'],
      ['body_html', 'bodyHtml'],
      ['logo_path', 'logoPath'],
      ['job_title', 'jobTitle'],
      ['department', 'department'],
      ['phone', 'phone'],
      ['website', 'website'],
      ['disclaimer', 'disclaimer'],
    ];
    for (const [col, camel] of textFields) {
      const v = b[camel] ?? b[col];
      if (v !== undefined) set(col, v === null ? null : String(v));
    }
    if (b.social !== undefined) set('social', JSON.stringify(b.social ?? {}));
    if (b.isActive !== undefined || b.is_active !== undefined)
      set('is_active', boolOf(b.isActive ?? b.is_active) ?? true);

    const wantsDefault = b.isDefault ?? b.is_default;
    if (wantsDefault !== undefined && (boolOf(wantsDefault) ?? false)) set('is_default', true);
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    await c.query(
      `UPDATE email_signatures SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      params
    );
    if (wantsDefault !== undefined && (boolOf(wantsDefault) ?? false)) {
      await clearOtherDefaultSignatures(c, ctx, id, mailboxId);
    }
    await auditMail(c, ctx, 'MAIL_SIGNATURE_UPDATED', 'email_signature', id, {
      fields: sets.map((s) => s.split(' =')[0]),
    });
    const { rows } = await c.query(
      `SELECT * FROM email_signatures WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    return { signature: toSignature(rows[0]) };
  })
);

/** Active signatures are deactivated, never deleted: sent mail references them. */
mailOpsRouter.delete(
  '/signatures/:id',
  ...run('communication.mail_signatures.delete', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'signature id');
    await loadSignatureForWrite(c, ctx, auth?.permissions, id);
    await c.query(
      `UPDATE email_signatures
          SET is_active = false, is_default = false, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    await auditMail(c, ctx, 'MAIL_SIGNATURE_DELETED', 'email_signature', id, {});
    return { id, isActive: false };
  })
);

mailOpsRouter.post(
  '/signatures/:id/default',
  ...run('communication.mail_signatures.update', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'signature id');
    const existing = await loadSignatureForWrite(c, ctx, auth?.permissions, id);
    const mailboxId = mailboxIdOf(existing);
    await c.query(
      `UPDATE email_signatures SET is_default = true, is_active = true, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    await clearOtherDefaultSignatures(c, ctx, id, mailboxId);
    await auditMail(c, ctx, 'MAIL_SIGNATURE_DEFAULT_SET', 'email_signature', id, { mailboxId });
    return { signature: await resolveSignature(c, ctx, id, mailboxId) };
  })
);

// ---------------------------------------------------------------------------
// Distribution lists
// ---------------------------------------------------------------------------

mailOpsRouter.get(
  '/distribution-lists',
  ...runGet('communication.mail_distribution_lists.view', async (c, ctx) => {
    const { rows } = await c.query(
      `SELECT l.*,
              (SELECT count(*) FROM email_distribution_members m
                WHERE m.list_id = l.id AND m.is_active = true) AS member_count
         FROM email_distribution_lists l
        WHERE l.tenant_id = $1
        ORDER BY l.name`,
      [ctx.tenantId ?? 0]
    );
    return { lists: toCamelRows(rows) };
  })
);

mailOpsRouter.post(
  '/distribution-lists',
  ...run('communication.mail_distribution_lists.create', async (c, ctx, b) => {
    const code = String(b.code ?? '').trim();
    const name = String(b.name ?? '').trim();
    const address = String(b.address ?? '').trim().toLowerCase();
    if (code.length === 0) throw badRequest('A list code is required.');
    if (name.length === 0) throw badRequest('A list name is required.');
    if (!EMAIL_RE.test(address)) throw badRequest('A valid list address is required.');

    const { rows: clash } = await c.query(
      `SELECT id, code, address FROM email_distribution_lists
        WHERE tenant_id = $1 AND (lower(code) = lower($2) OR lower(address) = $3)`,
      [ctx.tenantId ?? 0, code, address]
    );
    if (clash.length > 0) {
      const hit = clash[0] as Record<string, unknown>;
      throw conflict(
        String(hit.address).toLowerCase() === address
          ? 'Another distribution list already uses that address.'
          : 'Another distribution list already uses that code.'
      );
    }

    const { rows } = await c.query(
      `INSERT INTO email_distribution_lists
         (tenant_id, code, name, address, description, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       RETURNING *`,
      [ctx.tenantId ?? 0, code, name, address, b.description ?? null, ctx.userId ?? null]
    );
    const list = toCamelRow(rows[0] as Record<string, unknown>);
    await auditMail(c, ctx, 'MAIL_DISTRIBUTION_LIST_CREATED', 'email_distribution_list', Number(list.id), {
      code,
      address,
    });
    return { list };
  })
);

mailOpsRouter.patch(
  '/distribution-lists/:id',
  ...run('communication.mail_distribution_lists.update', async (c, ctx, b, p) => {
    const id = idOf(p.id, 'distribution list id');
    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length === 0) throw badRequest('A list name is required.');
      set('name', name);
    }
    if (b.code !== undefined) {
      const code = String(b.code).trim();
      if (code.length === 0) throw badRequest('A list code is required.');
      set('code', code);
    }
    if (b.address !== undefined) {
      const address = String(b.address).trim().toLowerCase();
      if (!EMAIL_RE.test(address)) throw badRequest('A valid list address is required.');
      set('address', address);
    }
    if (b.description !== undefined) set('description', b.description ?? null);
    if (b.isActive !== undefined || b.is_active !== undefined)
      set('is_active', boolOf(b.isActive ?? b.is_active) ?? true);
    if (sets.length === 0) throw badRequest('No supported fields supplied');

    const { rowCount } = await c.query(
      `UPDATE email_distribution_lists SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      params
    );
    if (!rowCount) throw notFound('Distribution list not found');
    await auditMail(c, ctx, 'MAIL_DISTRIBUTION_LIST_UPDATED', 'email_distribution_list', id, {
      fields: sets.map((s) => s.split(' =')[0]),
    });
    const { rows } = await c.query(
      `SELECT * FROM email_distribution_lists WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    return { list: toCamelRow(rows[0] as Record<string, unknown>) };
  })
);

mailOpsRouter.delete(
  '/distribution-lists/:id',
  ...run('communication.mail_distribution_lists.delete', async (c, ctx, _b, p) => {
    const id = idOf(p.id, 'distribution list id');
    const { rowCount } = await c.query(
      `UPDATE email_distribution_lists SET is_active = false, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId ?? 0]
    );
    if (!rowCount) throw notFound('Distribution list not found');
    await auditMail(c, ctx, 'MAIL_DISTRIBUTION_LIST_DELETED', 'email_distribution_list', id, {});
    return { id, isActive: false };
  })
);

mailOpsRouter.get(
  '/distribution-lists/:id/members',
  ...runGet('communication.mail_distribution_lists.view', async (c, ctx, _q, p) => {
    const listId = idOf(p.id, 'distribution list id');
    const { rows: list } = await c.query(
      `SELECT id FROM email_distribution_lists WHERE id = $1 AND tenant_id = $2`,
      [listId, ctx.tenantId ?? 0]
    );
    if (list.length === 0) throw notFound('Distribution list not found');
    const { rows } = await c.query(
      `SELECT m.*, u.first_name, u.last_name, u.email AS user_email,
              mb.display_name AS mailbox_name, d.name AS department_name
         FROM email_distribution_members m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
         LEFT JOIN departments d ON d.id = m.department_id
        WHERE m.list_id = $1 AND m.tenant_id = $2
        ORDER BY m.member_type, m.name NULLS LAST, m.id`,
      [listId, ctx.tenantId ?? 0]
    );
    return { members: toCamelRows(rows) };
  })
);

/** A member is exactly one of: a user, a mailbox, a department or a raw address. */
mailOpsRouter.post(
  '/distribution-lists/:id/members',
  ...run('communication.mail_distribution_lists.create', async (c, ctx, b, p) => {
    const listId = idOf(p.id, 'distribution list id');
    const tenantId = ctx.tenantId ?? 0;
    const memberType = String(b.memberType ?? b.member_type ?? 'USER').toUpperCase();
    if (!['USER', 'EMAIL', 'MAILBOX', 'DEPARTMENT'].includes(memberType))
      throw badRequest('memberType must be USER, EMAIL, MAILBOX or DEPARTMENT');

    const { rows: list } = await c.query(
      `SELECT id FROM email_distribution_lists WHERE id = $1 AND tenant_id = $2`,
      [listId, tenantId]
    );
    if (list.length === 0) throw notFound('Distribution list not found');

    let userId: number | null = null;
    let mailboxId: number | null = null;
    let departmentId: number | null = null;
    let email: string | null = null;
    let name: string | null = b.name === undefined || b.name === null ? null : String(b.name);

    if (memberType === 'USER') {
      userId = idOf(b.userId ?? b.user_id, 'user id');
      const { rows } = await c.query(`SELECT id, first_name, last_name FROM users WHERE id = $1 AND tenant_id = $2`, [
        userId,
        tenantId,
      ]);
      if (rows.length === 0) throw notFound('User not found in this tenant');
      if (name === null) name = `${String(rows[0].first_name ?? '')} ${String(rows[0].last_name ?? '')}`.trim();
    } else if (memberType === 'MAILBOX') {
      mailboxId = idOf(b.mailboxId ?? b.mailbox_id, 'mailbox id');
      const { rows } = await c.query(
        `SELECT id, display_name FROM mailboxes WHERE id = $1 AND tenant_id = $2`,
        [mailboxId, tenantId]
      );
      if (rows.length === 0) throw notFound('Mailbox not found in this tenant');
      if (name === null) name = String(rows[0].display_name ?? '');
    } else if (memberType === 'DEPARTMENT') {
      departmentId = idOf(b.departmentId ?? b.department_id, 'department id');
      const { rows } = await c.query(
        `SELECT id, name FROM departments WHERE id = $1 AND tenant_id = $2`,
        [departmentId, tenantId]
      );
      if (rows.length === 0) throw notFound('Department not found in this tenant');
      if (name === null) name = String(rows[0].name ?? '');
    } else {
      email = String(b.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw badRequest('A valid member email address is required.');
    }

    const { rows } = await c.query(
      `INSERT INTO email_distribution_members
         (tenant_id, list_id, member_type, user_id, mailbox_id, department_id, email, name, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING *`,
      [tenantId, listId, memberType, userId, mailboxId, departmentId, email, name]
    );
    const member = toCamelRow(rows[0] as Record<string, unknown>);
    await auditMail(c, ctx, 'MAIL_DISTRIBUTION_MEMBER_ADDED', 'email_distribution_member', Number(member.id), {
      listId,
      memberType,
    });
    return { member };
  })
);

mailOpsRouter.delete(
  '/distribution-lists/:id/members/:memberId',
  ...run('communication.mail_distribution_lists.delete', async (c, ctx, _b, p) => {
    const listId = idOf(p.id, 'distribution list id');
    const memberId = idOf(p.memberId, 'member id');
    const { rowCount } = await c.query(
      `UPDATE email_distribution_members SET is_active = false, updated_at = now()
        WHERE id = $1 AND list_id = $2 AND tenant_id = $3`,
      [memberId, listId, ctx.tenantId ?? 0]
    );
    if (!rowCount) throw notFound('Distribution member not found');
    await auditMail(c, ctx, 'MAIL_DISTRIBUTION_MEMBER_REMOVED', 'email_distribution_member', memberId, {
      listId,
    });
    return { id: memberId, isActive: false };
  })
);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The mailbox in scope for a label, or null for a tenant-wide label. */
function labelMailboxId(label: Record<string, unknown>): number | null {
  return label.mailbox_id === null || label.mailbox_id === undefined ? null : Number(label.mailbox_id);
}

/**
 * Load a label the caller may read: either attached to a mailbox they can view,
 * or tenant-wide.
 */
async function loadLabel(
  c: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  labelId: number
): Promise<Record<string, unknown>> {
  const { rows } = await c.query(`SELECT * FROM email_labels WHERE id = $1 AND tenant_id = $2`, [
    labelId,
    ctx.tenantId ?? 0,
  ]);
  if (rows.length === 0) throw notFound('Label not found');
  const label = rows[0] as Record<string, unknown>;
  const mailboxId = labelMailboxId(label);
  if (mailboxId === null) {
    if (!isMailAdmin(permissions)) throw forbidden('You do not have permission to manage shared labels');
    return label;
  }
  const access = await resolveMailboxAccess(c, ctx, permissions, mailboxId);
  assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
  return label;
}

mailOpsRouter.get(
  '/mailboxes/:id/labels',
  ...runGet('communication.mail_labels.view', async (c, ctx, _q, p, auth) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
    assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    const { rows } = await c.query(
      `SELECT * FROM email_labels
        WHERE tenant_id = $1 AND (mailbox_id = $2 OR mailbox_id IS NULL)
        ORDER BY kind, name`,
      [ctx.tenantId ?? 0, mailboxId]
    );
    return { labels: toCamelRows(rows) };
  })
);

mailOpsRouter.post(
  '/mailboxes/:id/labels',
  ...run('communication.mail_labels.create', async (c, ctx, b, p, auth) => {
    const mailboxId = idOf(p.id, 'mailbox id');
    const name = String(b.name ?? '').trim();
    if (name.length === 0) throw badRequest('A label name is required.');
    const kind = String(b.kind ?? 'USER').toUpperCase();
    if (!['USER', 'SYSTEM', 'CLASSIFICATION'].includes(kind))
      throw badRequest('kind must be USER, SYSTEM or CLASSIFICATION');
    const tenantWide = boolOf(b.tenantWide ?? b.tenant_wide) ?? false;
    if (kind !== 'USER' || tenantWide) {
      if (!isMailAdmin(auth?.permissions)) throw forbidden('You do not have permission to manage shared labels');
    }
    if (tenantWide) {
      const { rows: clash } = await c.query(
        `SELECT id FROM email_labels
          WHERE tenant_id = $1 AND mailbox_id IS NULL AND lower(name) = lower($2)`,
        [ctx.tenantId ?? 0, name]
      );
      if (clash.length > 0) throw conflict('A shared label with that name already exists.');
    } else {
      const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
      assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
      const { rows: clash } = await c.query(
        `SELECT id FROM email_labels
          WHERE tenant_id = $1 AND mailbox_id = $2 AND lower(name) = lower($3)`,
        [ctx.tenantId ?? 0, mailboxId, name]
      );
      if (clash.length > 0) throw conflict('A label with that name already exists on this mailbox.');
    }

    const { rows } = await c.query(
      `INSERT INTO email_labels
         (tenant_id, mailbox_id, name, color, kind, is_system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        ctx.tenantId ?? 0,
        tenantWide ? null : mailboxId,
        name,
        String(b.color ?? 'slate'),
        kind,
        kind !== 'USER',
        ctx.userId ?? null,
      ]
    );
    const label = toCamelRow(rows[0] as Record<string, unknown>);
    await auditMail(c, ctx, 'MAIL_LABEL_CREATED', 'email_label', Number(label.id), {
      mailboxId: tenantWide ? null : mailboxId,
      kind,
    });
    return { label };
  })
);

mailOpsRouter.patch(
  '/labels/:id',
  ...run('communication.mail_labels.update', async (c, ctx, b, p, auth) => {
    const id = idOf(p.id, 'label id');
    const existing = await loadLabel(c, ctx, auth?.permissions, id);
    const mailboxId = labelMailboxId(existing);
    if (mailboxId !== null) {
      const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
      assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    }
    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId ?? 0];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length === 0) throw badRequest('A label name is required.');
      set('name', name);
    }
    if (b.color !== undefined) set('color', String(b.color));
    if (sets.length === 0) throw badRequest('No supported fields supplied');
    await c.query(
      `UPDATE email_labels SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      params
    );
    await auditMail(c, ctx, 'MAIL_LABEL_UPDATED', 'email_label', id, {
      fields: sets.map((s) => s.split(' =')[0]),
    });
    const { rows } = await c.query(`SELECT * FROM email_labels WHERE id = $1 AND tenant_id = $2`, [
      id,
      ctx.tenantId ?? 0,
    ]);
    return { label: toCamelRow(rows[0] as Record<string, unknown>) };
  })
);

mailOpsRouter.delete(
  '/labels/:id',
  ...run('communication.mail_labels.delete', async (c, ctx, _b, p, auth) => {
    const id = idOf(p.id, 'label id');
    const existing = await loadLabel(c, ctx, auth?.permissions, id);
    const mailboxId = labelMailboxId(existing);
    if (mailboxId !== null) {
      const access = await resolveMailboxAccess(c, ctx, auth?.permissions, mailboxId);
      assertMailboxPermission(access, 'canView', 'You do not have access to this mailbox');
    }
    if (existing.is_system === true && !isMailAdmin(auth?.permissions))
      throw forbidden('System labels can only be removed by a mail administrator.');
    await c.query(`DELETE FROM email_labels WHERE id = $1 AND tenant_id = $2`, [id, ctx.tenantId ?? 0]);
    await auditMail(c, ctx, 'MAIL_LABEL_DELETED', 'email_label', id, { mailboxId });
    return { id, deleted: true };
  })
);

mailOpsRouter.post(
  '/messages/:id/labels',
  ...run('communication.mail_labels.update', async (c, ctx, b, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    const labelId = idOf(b.labelId ?? b.label_id, 'label id');
    const { email } = await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      emailId,
      'canView',
      'You do not have permission to change this message'
    );
    const label = await loadLabel(c, ctx, auth?.permissions, labelId);
    const labelMailbox = labelMailboxId(label);
    const messageMailbox = mailboxIdOf(email);
    if (labelMailbox !== null && labelMailbox !== messageMailbox)
      throw badRequest('That label belongs to a different mailbox.');
    const { rows } = await c.query(
      `INSERT INTO email_message_labels (tenant_id, email_id, label_id, applied_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email_id, label_id) DO NOTHING
       RETURNING id`,
      [ctx.tenantId ?? 0, emailId, labelId, ctx.userId ?? null]
    );
    await auditMail(c, ctx, 'MAIL_MESSAGE_LABEL_APPLIED', 'email', emailId, { labelId }, messageMailbox);
    return { emailId, labelId, applied: rows.length > 0 };
  })
);

mailOpsRouter.delete(
  '/messages/:id/labels/:labelId',
  ...run('communication.mail_labels.update', async (c, ctx, _b, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    const labelId = idOf(p.labelId, 'label id');
    const { email } = await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      emailId,
      'canView',
      'You do not have permission to change this message'
    );
    const { rowCount } = await c.query(
      `DELETE FROM email_message_labels WHERE email_id = $1 AND label_id = $2 AND tenant_id = $3`,
      [emailId, labelId, ctx.tenantId ?? 0]
    );
    if (!rowCount) throw notFound('That label is not applied to this message');
    await auditMail(c, ctx, 'MAIL_MESSAGE_LABEL_REMOVED', 'email', emailId, { labelId }, mailboxIdOf(email));
    return { emailId, labelId, applied: false };
  })
);
/* ==========================================================================
 * Chunk D - attachments, delivery evidence, audit trail, search, providers.
 *
 * Appended after the mailbox/label routes on purpose: nothing above this line
 * is reordered or redefined. Every route below reuses the loaders already
 * declared in this file (messageScope / loadForRead / loadForWrite / auditMail)
 * and the services the router already imports at the top. No new module, no
 * second mail stack, no parallel workflow engine.
 * ========================================================================== */

/**
 * Attachment budget, mirrored from services/mail/send.ts.
 *
 * send.ts keeps its own copies private, so they are restated here rather than
 * exported. If the send-time limits move, move these with them: an attachment
 * accepted here but refused at send time would be a lie in the composer.
 */
const MAX_ATTACHMENT_COUNT = 20;
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'zip', 'eml', 'msg',
]);

/**
 * Root-relative storage key for a mail attachment. Always forward slashes: the
 * value is persisted and may be read by a different operating system later.
 */
function attachmentStorageRel(
  tenantId: number,
  companyId: number | null | undefined,
  emailId: number,
  attachmentId: number,
  ext: string
): string {
  return `dms/${tenantId}/${companyId ?? 0}/mail/${emailId}/${attachmentId}${ext}`;
}

/** Reject an upload whose extension is not on the relayable list. */
function assertAllowedAttachmentName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const bare = ext.replace(/^\./, '');
  if (!bare || !ALLOWED_ATTACHMENT_EXT.has(bare)) {
    throw badRequest(
      `Unsupported file type${bare ? ` ".${bare}"` : ''}. ` +
        `Allowed types: ${[...ALLOWED_ATTACHMENT_EXT].join(', ')}.`
    );
  }
  return ext;
}

/**
 * Refuse a third or fifty-first attachment, or one that would push the message
 * past the provider ceiling. Counting and summing are done in SQL so concurrent
 * uploads cannot both slip through a stale client-side count.
 */
async function assertAttachmentBudget(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number,
  incomingBytes: number
): Promise<void> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count, COALESCE(sum(file_size), 0)::bigint AS total
       FROM email_attachments
      WHERE email_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [emailId, tenantId]
  );
  const count = Number(rows[0]?.count ?? 0);
  const total = Number(rows[0]?.total ?? 0);
  if (count >= MAX_ATTACHMENT_COUNT) {
    throw badRequest(`A message can carry at most ${MAX_ATTACHMENT_COUNT} attachments.`);
  }
  if (total + incomingBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw badRequest(
      'This file would take the message over the 18 MB attachment limit. ' +
        'Remove an attachment or send it in a separate message.'
    );
  }
}

/** Recompute the message's attachment flag from the rows that actually remain. */
async function refreshAttachmentFlag(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number
): Promise<void> {
  await client.query(
    `UPDATE emails
        SET has_attachments = EXISTS (
              SELECT 1 FROM email_attachments a
               WHERE a.email_id = $1 AND a.tenant_id = $2 AND a.deleted_at IS NULL
            ),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
}

/* --------------------------------------------------------------------------
 * A. Delivery evidence.
 *
 * The provider is the only authority on whether a message was delivered. We
 * replay what the webhook actually recorded and expose the derived status as a
 * separate field so the UI can say "no evidence yet" instead of guessing.
 * -------------------------------------------------------------------------- */
mailOpsRouter.get(
  '/messages/:id/delivery-events',
  ...runGet('communication.emails.view', async (c, ctx, _q, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    await loadForRead(c, ctx, auth?.permissions, emailId);

    // Already camel-cased by the delivery service - do NOT run toCamelRows here.
    const events = await listDeliveryEvents(c, ctx.tenantId ?? 0, emailId);
    const providerStatus = confirmedStatus(events);
    return { events, providerStatus };
  })
);

/* --------------------------------------------------------------------------
 * B. Mail audit trail.
 *
 * communication_audit_logs is shared with the rest of the comms stack, so the
 * projection is written out column by column rather than SELECT *: a future
 * column on that table must not silently start leaking through this endpoint.
 *
 * mailbox_id / message_id / device / result arrive with migration 0169.
 * -------------------------------------------------------------------------- */
const MAIL_AUDIT_COLUMNS = `
  a.id, a.tenant_id, a.company_id, a.user_id, a.action, a.target_type,
  a.target_id, a.detail, a.ip, a.user_agent, a.mailbox_id, a.message_id,
  a.device, a.result, a.created_at,
  u.first_name AS actor_first_name,
  u.last_name AS actor_last_name,
  u.email AS actor_email`;

mailOpsRouter.get(
  '/audit',
  ...runGet('communication.mail_audit.view', async (c, ctx, q) => {
    const { page, pageSize, offset } = parsePagination(q);
    const params: unknown[] = [ctx.tenantId ?? 0];
    const where: string[] = ['a.tenant_id = $1'];
    const add = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const messageId = typeof q.messageId === 'string' && q.messageId.trim() ? q.messageId.trim() : null;
    if (messageId) where.push(`a.message_id = $${add(messageId)}`);

    const mailboxId = NUM(q.mailboxId);
    if (mailboxId !== null) where.push(`a.mailbox_id = $${add(mailboxId)}`);

    const userId = NUM(q.userId);
    if (userId !== null) where.push(`a.user_id = $${add(userId)}`);

    const action = typeof q.action === 'string' && q.action.trim()
      ? q.action.trim().toUpperCase()
      : null;
    if (action) where.push(`a.action = $${add(action)}`);

    if (typeof q.dateFrom === 'string' && q.dateFrom.trim()) {
      where.push(`a.created_at >= $${add(q.dateFrom.trim())}`);
    }
    if (typeof q.dateTo === 'string' && q.dateTo.trim()) {
      where.push(`a.created_at <= $${add(q.dateTo.trim())}`);
    }

    const { rows } = await c.query(
      `SELECT ${MAIL_AUDIT_COLUMNS}, COUNT(*) OVER() AS _total
         FROM communication_audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${add(pageSize)} OFFSET $${add(offset)}`,
      params
    );

    const total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;
    return {
      rows: toCamelRows(rows.map(stripTotal)),
      pagination: { page, pageSize, total },
    };
  })
);

/* --------------------------------------------------------------------------
 * C. Bounded mail search.
 *
 * Deliberately NOT a paged register: this backs the command palette and jumps
 * straight to a record, so it returns a small, ordered, capped slice and says
 * out loud that it was capped. Scope comes from messageScope(), so a search can
 * only ever see mailboxes the caller may already read.
 * -------------------------------------------------------------------------- */
const SEARCH_LIMIT = 50;

mailOpsRouter.get(
  '/search',
  ...runGet('communication.emails.view', async (c, ctx, q, _p, auth) => {
    const term = typeof q.q === 'string' ? q.q.trim() : '';
    if (!term) throw badRequest('A search term is required');

    const scope = await messageScope(c, ctx, auth?.permissions);
    const params = [...scope.params];
    const where: string[] = ['e.tenant_id = $1', 'e.deleted_at IS NULL'];
    if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));
    const add = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const like = add(`%${term}%`);
    const exact = add(term);
    where.push(
      `(e.subject ILIKE $${like} OR e.body ILIKE $${like} OR e.from_email ILIKE $${like}` +
        ` OR e.from_name ILIKE $${like}` +
        ` OR e.entity_type ILIKE $${like} OR e.entity_id::text = $${exact}` +
        ` OR EXISTS (SELECT 1 FROM email_recipients r WHERE r.email_id = e.id` +
        ` AND (r.email ILIKE $${like} OR r.name ILIKE $${like})))`
    );

    const { rows } = await c.query(
      `SELECT ${MESSAGE_LIST_COLUMNS}, ${MESSAGE_LIST_EXTRAS}
         FROM emails e
         ${MESSAGE_LIST_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC NULLS LAST, e.id DESC
        LIMIT $${add(SEARCH_LIMIT)}`,
      params
    );

    return {
      rows: toCamelRows(rows),
      limit: SEARCH_LIMIT,
      truncated: rows.length >= SEARCH_LIMIT,
    };
  })
);

/* --------------------------------------------------------------------------
 * D. Attach an existing ERP document to a message.
 *
 * Attaching copies the bytes into the mail store rather than pointing at the
 * DMS path. Two reasons, both load-bearing:
 *   1. send.ts re-reads every attachment from disk and re-checks its extension
 *      and size before relaying, so a link alone would not survive a send.
 *   2. a copy freezes what was actually sent - later editing or deleting the
 *      source document cannot silently rewrite an already-issued email.
 * The audit row records the origin document id so the link is not lost.
 * -------------------------------------------------------------------------- */
mailOpsRouter.post(
  '/messages/:id/attachments/erp',
  ...run('communication.mail_attachments.upload', async (c, ctx, b, p, auth) => {
    const emailId = idOf(p.id, 'message id');
    const loaded = await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      emailId,
      'canSend',
      'You do not have permission to attach files to this message'
    );

    const documentId = idOf(b.documentId, 'document id');
    const { rows: docRows } = await c.query(
      `SELECT id, file_name, file_type, file_size, storage_path, classification
         FROM dms_documents
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [documentId, ctx.tenantId ?? 0]
    );
    if (docRows.length === 0) throw notFound('Document not found');
    const doc = docRows[0] as Record<string, unknown>;

    const fileName = typeof doc.file_name === 'string' ? doc.file_name.trim() : '';
    if (!fileName) {
      throw badRequest(
        'That document has no stored file. Upload a file against it in Document Management first.'
      );
    }
    const ext = assertAllowedAttachmentName(fileName);

    const sourceRel = doc.storage_path == null ? '' : String(doc.storage_path);
    if (!sourceRel || sourceRel.includes('..')) {
      throw notFound('No file has been uploaded for this document');
    }
    const sourceAbs = path.join(config.storageRoot, sourceRel);
    if (!existsSync(sourceAbs)) throw notFound('File not found on storage');

    // Refuse to down-classify: a document more sensitive than the message it
    // travels on would silently leave the building under a weaker label.
    const docClassification = await loadClassification(
      c,
      ctx.tenantId ?? 0,
      String(doc.classification ?? 'INTERNAL')
    );
    if (docClassification.rank > loaded.classification.rank) {
      throw forbidden(
        `"${fileName}" is classified ${docClassification.label}, which is more sensitive than ` +
          `this message (${loaded.classification.label}). Raise the message classification first.`
      );
    }

    const buffer = readFileSync(sourceAbs);
    await assertAttachmentBudget(c, ctx.tenantId ?? 0, emailId, buffer.length);
    const hash = createHash('sha256').update(buffer).digest('hex');

    const { rows: insRows } = await c.query(
      `INSERT INTO email_attachments
         (tenant_id, email_id, file_name, file_type, file_size, storage_path,
          content_hash, source, scan_status, dms_document_id, entity_type,
          entity_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'ERP_DOCUMENT','SKIPPED',$7,$8,$9,$10)
       RETURNING id`,
      [
        ctx.tenantId ?? 0,
        emailId,
        fileName,
        doc.file_type == null ? null : String(doc.file_type),
        buffer.length,
        hash,
        documentId,
        typeof b.entityType === 'string' && b.entityType.trim()
          ? b.entityType.trim().toUpperCase()
          : 'DMS_DOCUMENT',
        typeof b.entityId === 'number' || typeof b.entityId === 'string'
          ? Number(b.entityId)
          : documentId,
        ctx.userId ?? null,
      ]
    );
    const attachmentId = Number(insRows[0].id);

    const rel = attachmentStorageRel(ctx.tenantId ?? 0, ctx.companyId, emailId, attachmentId, ext);
    const abs = path.join(config.storageRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buffer);

    await c.query(
      `UPDATE email_attachments
          SET storage_path = $1, content_hash = $2, file_size = $3, updated_at = now()
        WHERE id = $4 AND tenant_id = $5`,
      [rel, hash, buffer.length, attachmentId, ctx.tenantId ?? 0]
    );
    await refreshAttachmentFlag(c, ctx.tenantId ?? 0, emailId);
    await auditMail(
      c,
      ctx,
      'EMAIL_ATTACHMENT_ATTACHED',
      'email',
      emailId,
      { attachmentId, documentId, fileName, source: 'ERP_DOCUMENT' },
      mailboxIdOf(loaded.email)
    );

    return {
      id: attachmentId,
      fileName,
      fileType: doc.file_type ?? null,
      fileSize: buffer.length,
      source: 'ERP_DOCUMENT',
      dmsDocumentId: documentId,
    };
  })
);

/* --------------------------------------------------------------------------
 * E. Upload a new file onto a message.
 *
 * Multer cannot run inside run()/runGet() - those wrap the handler in tx(), and
 * multer must stream the body to disk/memory *before* a database transaction is
 * opened. So the middleware chain is written out explicitly: permission check,
 * then multer, then the handler that opens the transaction.
 * -------------------------------------------------------------------------- */
const mailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

mailOpsRouter.post(
  '/messages/:id/attachments',
  requirePermission('communication.mail_attachments.upload'),
  mailUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('A file is required (field "file")');

    const out = await tx(async (client, ctx) => {
      const emailId = idOf(req.params.id, 'message id');
      const loaded = await loadForWrite(
        client,
        ctx,
        req.auth?.permissions,
        emailId,
        'canSend',
        'You do not have permission to attach files to this message'
      );

      const fileName = String(file.originalname ?? '').trim();
      if (!fileName) throw badRequest('The uploaded file has no name');
      const ext = assertAllowedAttachmentName(fileName);

      const buffer = file.buffer as Buffer;
      const size = buffer.length;
      if (size > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw badRequest('A single attachment must be 18 MB or smaller.');
      }
      await assertAttachmentBudget(client, ctx.tenantId ?? 0, emailId, size);

      const hash = createHash('sha256').update(buffer).digest('hex');
      const { rows: insRows } = await client.query(
        `INSERT INTO email_attachments
           (tenant_id, email_id, file_name, file_type, file_size, storage_path,
            content_hash, source, scan_status, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,'UPLOAD','NOT_SCANNED',$7)
         RETURNING id`,
        [
          ctx.tenantId ?? 0,
          emailId,
          fileName,
          file.mimetype ?? null,
          size,
          hash,
          // uploaded_by references users(id): never 0, which would fail the FK.
          ctx.userId ?? null,
        ]
      );
      const attachmentId = Number(insRows[0].id);

      const rel = attachmentStorageRel(ctx.tenantId ?? 0, ctx.companyId, emailId, attachmentId, ext);
      const abs = path.join(config.storageRoot, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, buffer);

      // The row exists but has no bytes until this update lands. Both statements
      // share one transaction, so a failed write removes the row rather than
      // leaving a phantom attachment behind.
      await client.query(
        `UPDATE email_attachments
            SET storage_path = $1, content_hash = $2, file_size = $3, updated_at = now()
          WHERE id = $4 AND tenant_id = $5`,
        [rel, hash, size, attachmentId, ctx.tenantId ?? 0]
      );
      await refreshAttachmentFlag(client, ctx.tenantId ?? 0, emailId);
      await auditMail(
        client,
        ctx,
        'EMAIL_ATTACHMENT_UPLOADED',
        'email',
        emailId,
        { attachmentId, fileName, fileSize: size, source: 'UPLOAD', scanStatus: 'NOT_SCANNED' },
        mailboxIdOf(loaded.email)
      );

      return {
        id: attachmentId,
        fileName,
        fileType: file.mimetype ?? null,
        fileSize: size,
        source: 'UPLOAD',
        scanStatus: 'NOT_SCANNED',
      };
    }, req.ctx);

    res.status(201).json({ data: out });
  })
);

/* --------------------------------------------------------------------------
 * F. Attachment download.
 *
 * Access is decided inside a transaction that only reads; the file is then
 * served outside it. pool is never handed to loadForRead - that helper expects a
 * checked-out client whose tenant context has been applied.
 *
 * Files are always sent as an attachment with a sanitised filename: an inline
 * disposition would let an HTML or SVG upload run in the app's origin.
 * -------------------------------------------------------------------------- */
mailOpsRouter.get(
  '/attachments/:id/download',
  requirePermission('communication.mail_attachments.download'),
  asyncHandler(async (req, res) => {
    const attachmentId = idOf(req.params.id, 'attachment id');

    const row = await tx(async (client, ctx) => {
      const { rows } = await client.query(
        `SELECT a.id, a.email_id, a.file_name, a.file_type, a.storage_path
           FROM email_attachments a
           JOIN emails e ON e.id = a.email_id
          WHERE a.id = $1 AND a.tenant_id = $2 AND a.deleted_at IS NULL`,
        [attachmentId, ctx.tenantId ?? 0]
      );
      if (rows.length === 0) throw notFound('Attachment not found');
      const found = rows[0] as Record<string, unknown>;

      const emailId = Number(found.email_id);
      const loaded = await loadForRead(client, ctx, req.auth?.permissions, emailId);
      assertClassificationAllows(loaded.classification, 'DOWNLOAD');

      await auditMail(
        client,
        ctx,
        'EMAIL_ATTACHMENT_DOWNLOADED',
        'email',
        emailId,
        { attachmentId, fileName: found.file_name },
        mailboxIdOf(loaded.email)
      );
      return found;
    }, req.ctx);

    const rel = row.storage_path == null ? '' : String(row.storage_path);
    if (!rel || rel.includes('..')) throw notFound('No file has been uploaded for this attachment');
    const abs = path.join(config.storageRoot, rel);
    if (!existsSync(abs)) throw notFound('File not found on storage');

    const bytes = readFileSync(abs);
    const fileName = String(row.file_name ?? 'attachment').replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', String(row.file_type ?? 'application/octet-stream'));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  })
);

/* --------------------------------------------------------------------------
 * G. Remove an attachment.
 *
 * Soft delete, matching the rest of the mail stack: the audit trail and any
 * already-sent copy stay intact, and has_attachments is recomputed from the
 * rows that remain rather than being forced to false.
 * -------------------------------------------------------------------------- */
mailOpsRouter.delete(
  '/attachments/:id',
  ...run('communication.mail_attachments.delete', async (c, ctx, _b, p, auth) => {
    const attachmentId = idOf(p.id, 'attachment id');

    const { rows } = await c.query(
      `SELECT id, email_id
         FROM email_attachments
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [attachmentId, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Attachment not found');
    const emailId = Number(rows[0].email_id);

    const loaded = await loadForWrite(
      c,
      ctx,
      auth?.permissions,
      emailId,
      'canSend',
      'You do not have permission to remove attachments from this message'
    );

    const { rowCount } = await c.query(
      `UPDATE email_attachments
          SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [attachmentId, ctx.tenantId ?? 0]
    );
    if (!rowCount) throw notFound('Attachment not found');

    await refreshAttachmentFlag(c, ctx.tenantId ?? 0, emailId);
    await auditMail(
      c,
      ctx,
      'EMAIL_ATTACHMENT_DELETED',
      'email',
      emailId,
      { attachmentId },
      mailboxIdOf(loaded.email)
    );

    return { id: attachmentId, deleted: true };
  })
);

/* --------------------------------------------------------------------------
 * H. Outbound provider configuration.
 *
 * IMPORTANT: nothing in the send path reads this table yet. These endpoints
 * persist and verify the row so an administrator can configure a provider and
 * prove the credentials decrypt; send.ts still resolves its credentials from
 * configuration. Until send.ts is repointed at this table, do not describe this
 * screen as "the live sending account".
 *
 * credentials_encrypted is never projected. A caller learns only whether
 * credentials exist, never their value or shape.
 * -------------------------------------------------------------------------- */
const MAIL_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'];
const MAIL_PROVIDERS = ['RESEND', 'SMTP', 'MICROSOFT365', 'GOOGLE_WORKSPACE'];
const UNIQUE_VIOLATION = '23505';

const PROVIDER_CONFIG_COLUMNS = `
  id, tenant_id, environment, provider, label, from_name, from_address, reply_to,
  inbound_address, config, is_active, is_default, last_verified_at, last_error,
  created_by, created_at, updated_at,
  (credentials_encrypted IS NOT NULL) AS has_credentials`;

function normaliseEnvironment(raw: unknown): string {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!MAIL_ENVIRONMENTS.includes(value)) {
    throw badRequest(`Unsupported environment "${raw}". Use ${MAIL_ENVIRONMENTS.join(' or ')}.`);
  }
  return value;
}

function normaliseProvider(raw: unknown): string {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!MAIL_PROVIDERS.includes(value)) {
    throw badRequest(`Unsupported provider "${raw}". Use ${MAIL_PROVIDERS.join(', ')}.`);
  }
  return value;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** Public shape of a provider config. Credentials never appear, in any form. */
function providerConfigView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id),
    environment: row.environment,
    provider: row.provider,
    label: row.label,
    fromName: row.from_name ?? null,
    fromAddress: row.from_address ?? null,
    replyTo: row.reply_to ?? null,
    inboundAddress: row.inbound_address ?? null,
    config: row.config ?? {},
    isActive: row.is_active !== false,
    isDefault: row.is_default === true,
    hasCredentials: row.has_credentials === true,
    lastVerifiedAt: row.last_verified_at ?? null,
    lastError: row.last_error ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

mailOpsRouter.get(
  '/provider-configs',
  ...runGet('communication.mail_providers.view', async (c, ctx, q) => {
    const params: unknown[] = [ctx.tenantId ?? 0];
    const where: string[] = ['tenant_id = $1'];

    if (typeof q.environment === 'string' && q.environment.trim()) {
      params.push(normaliseEnvironment(q.environment));
      where.push(`environment = $${params.length}`);
    }

    const { rows } = await c.query(
      `SELECT ${PROVIDER_CONFIG_COLUMNS}
         FROM email_provider_configs
        WHERE ${where.join(' AND ')}
        ORDER BY environment ASC, provider ASC, label ASC`,
      params
    );
    return { rows: rows.map(providerConfigView) };
  })
);

mailOpsRouter.post(
  '/provider-configs',
  ...run('communication.mail_providers.manage', async (c, ctx, b) => {
    const environment = normaliseEnvironment(b.environment);
    const provider = normaliseProvider(b.provider);
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : 'default';

    if (b.credentials === undefined || b.credentials === null) {
      throw badRequest('credentials is required');
    }
    const credentialsEncrypted = encryptSecret(
      typeof b.credentials === 'string' ? b.credentials : JSON.stringify(b.credentials)
    );

    let insertedId: number;
    try {
      const { rows } = await c.query(
        `INSERT INTO email_provider_configs
           (tenant_id, environment, provider, label, from_name, from_address,
            reply_to, inbound_address, credentials_encrypted, config, is_active,
            is_default, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          ctx.tenantId ?? 0,
          environment,
          provider,
          label,
          typeof b.fromName === 'string' && b.fromName.trim() ? b.fromName.trim() : null,
          typeof b.fromAddress === 'string' && b.fromAddress.trim() ? b.fromAddress.trim() : null,
          typeof b.replyTo === 'string' && b.replyTo.trim() ? b.replyTo.trim() : null,
          typeof b.inboundAddress === 'string' && b.inboundAddress.trim()
            ? b.inboundAddress.trim()
            : null,
          credentialsEncrypted,
          JSON.stringify(b.config && typeof b.config === 'object' ? b.config : {}),
          boolOf(b.isActive) ?? true,
          boolOf(b.isDefault) ?? false,
          ctx.userId ?? null,
        ]
      );
      insertedId = Number(rows[0].id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict(
          `A ${environment} ${provider} configuration labelled "${label}" already exists.`
        );
      }
      throw err;
    }

    const { rows: saved } = await c.query(
      `SELECT ${PROVIDER_CONFIG_COLUMNS}
         FROM email_provider_configs
        WHERE id = $1 AND tenant_id = $2`,
      [insertedId, ctx.tenantId ?? 0]
    );

    await auditMail(c, ctx, 'MAIL_PROVIDER_CONFIG_CREATED', 'provider_config', insertedId, {
      environment,
      provider,
      label,
    });

    return providerConfigView(saved[0]);
  })
);

mailOpsRouter.patch(
  '/provider-configs/:id',
  ...run('communication.mail_providers.manage', async (c, ctx, b, p) => {
    const configId = idOf(p.id, 'provider config id');
    const tenantId = ctx.tenantId ?? 0;

    const { rows: existingRows } = await c.query(
      `SELECT id, environment, provider FROM email_provider_configs
        WHERE id = $1 AND tenant_id = $2`,
      [configId, tenantId]
    );
    if (existingRows.length === 0) throw notFound('Provider configuration not found');

    const params: unknown[] = [configId, tenantId];
    const sets: string[] = [];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (b.environment !== undefined) set('environment', normaliseEnvironment(b.environment));
    if (b.provider !== undefined) set('provider', normaliseProvider(b.provider));
    if (b.label !== undefined) {
      set('label', typeof b.label === 'string' && b.label.trim() ? b.label.trim() : 'default');
    }
    if (b.fromName !== undefined) set('from_name', b.fromName == null ? null : String(b.fromName).trim() || null);
    if (b.fromAddress !== undefined) set('from_address', b.fromAddress == null ? null : String(b.fromAddress).trim() || null);
    if (b.replyTo !== undefined) set('reply_to', b.replyTo == null ? null : String(b.replyTo).trim() || null);
    if (b.inboundAddress !== undefined) set('inbound_address', b.inboundAddress == null ? null : String(b.inboundAddress).trim() || null);
    if (b.config !== undefined) set('config', JSON.stringify(b.config && typeof b.config === 'object' ? b.config : {}));

    const isActive = boolOf(b.isActive);
    if (isActive !== null) set('is_active', isActive);
    const isDefault = boolOf(b.isDefault);
    if (isDefault !== null) set('is_default', isDefault);

    // Replacing credentials is explicit: omitting the field leaves them alone,
    // and sending null does not silently erase them.
    if (b.credentials !== undefined && b.credentials !== null) {
      set(
        'credentials_encrypted',
        encryptSecret(typeof b.credentials === 'string' ? b.credentials : JSON.stringify(b.credentials))
      );
    }

    if (sets.length === 0) throw badRequest('No supported fields were supplied');
    sets.push('updated_at = now()');

    try {
      await c.query(
        `UPDATE email_provider_configs SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`,
        params
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Another configuration already uses that environment, provider and label.');
      }
      throw err;
    }

    // At most one default per environment+provider. Clearing the siblings is
    // what makes "default" mean anything to a future send path.
    if (isDefault === true) {
      await c.query(
        `UPDATE email_provider_configs
            SET is_default = false, updated_at = now()
          WHERE tenant_id = $1 AND environment = $2 AND provider = $3 AND id <> $4`,
        [
          tenantId,
          String(b.environment ? normaliseEnvironment(b.environment) : existingRows[0].environment),
          String(b.provider ? normaliseProvider(b.provider) : existingRows[0].provider),
          configId,
        ]
      );
    }

    const { rows: saved } = await c.query(
      `SELECT ${PROVIDER_CONFIG_COLUMNS}
         FROM email_provider_configs
        WHERE id = $1 AND tenant_id = $2`,
      [configId, tenantId]
    );

    await auditMail(c, ctx, 'MAIL_PROVIDER_CONFIG_UPDATED', 'provider_config', configId, {
      fields: sets
        .filter((s) => !s.startsWith('updated_at'))
        .map((s) => s.split(' = ')[0]),
    });

    return providerConfigView(saved[0]);
  })
);

// ─── Directory ──────────────────────────────────────────────────────────────
// Mailbox administration has to resolve a real user before a member row or a
// delegation can be created. Neither `/api/ops/admin/users` (admin.users.view)
// nor `/api/ops/hr/directory/users` (hr.employees.view) is appropriate here: a
// mailbox administrator is not necessarily a system administrator or an HR
// user. This lookup is therefore scoped to the mail module and gated on the
// permissions the caller already needs in order to mutate memberships and
// delegations. Tenant-scoped, read-only, identity fields only - never
// credentials, roles, sessions or MFA state.
mailOpsRouter.get(
  '/directory/users',
  ...runGet(
    ['communication.mailboxes.update', 'communication.mailbox_delegations.create'],
    async (c, ctx, q) => {
      const term = String(q.q ?? '').trim();
      const { rows } = await c.query(
        `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status
           FROM users u
          WHERE u.tenant_id = $1
            AND ($2 = '' OR u.username ILIKE $3 OR u.email ILIKE $3
                 OR u.first_name ILIKE $3 OR u.last_name ILIKE $3)
          ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST, u.username
          LIMIT 25`,
        [ctx.tenantId ?? 0, term, `%${term}%`]
      );
      return toCamelRows(rows);
    }
  )
);
