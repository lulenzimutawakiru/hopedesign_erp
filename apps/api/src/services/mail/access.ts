import pg from 'pg';
import { Ctx } from '../../db.js';
import { forbidden, notFound } from '../../utils.js';

/**
 * Mailbox-level permission flags. These mirror the boolean columns on
 * `mailbox_members` and the token list stored in `mailbox_delegations.permissions`.
 * They are *additional* to RBAC: holding `communication.mailboxes.view` does not
 * by itself grant access to a private mailbox.
 */
export interface MailboxPermissions {
  canView: boolean;
  canSend: boolean;
  canReply: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canDelegate: boolean;
  canExport: boolean;
  canAdmin: boolean;
}

export type MailboxPermissionFlag = keyof MailboxPermissions;

export const NO_MAILBOX_PERMISSIONS: MailboxPermissions = {
  canView: false,
  canSend: false,
  canReply: false,
  canDelete: false,
  canArchive: false,
  canDelegate: false,
  canExport: false,
  canAdmin: false,
};

export interface MailboxAccess extends MailboxPermissions {
  mailboxId: number;
  mailbox: Record<string, unknown>;
  /** OWNER | MANAGER | MEMBER | READ_ONLY when granted through membership. */
  memberRole: string | null;
  /** True when access came from an active delegation rather than membership. */
  viaDelegation: boolean;
  delegationId: number | null;
  /** Delegator the message is sent on behalf of (null when not delegated). */
  onBehalfOfUserId: number | null;
  onBehalfOfName: string | null;
  /** True for `*` / `system.admin.all` / `communication.admin` holders. */
  globalAdmin: boolean;
}

const truthy = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 't' || v === 'true';

/** Normalise a delegation permission token (`mail.send`, `SEND`, `canSend`, ...). */
function flagForToken(token: string): MailboxPermissionFlag | null {
  const key = token
    .trim()
    .toLowerCase()
    .replace(/^communication\./, '')
    .replace(/^mail\./, '')
    .replace(/^mailbox[._]/, '')
    .replace(/^can/, '');
  switch (key) {
    case 'view':
    case 'read':
      return 'canView';
    case 'send':
      return 'canSend';
    case 'reply':
      return 'canReply';
    case 'delete':
      return 'canDelete';
    case 'archive':
      return 'canArchive';
    case 'delegate':
      return 'canDelegate';
    case 'export':
      return 'canExport';
    case 'admin':
    case 'manage':
      return 'canAdmin';
    default:
      return null;
  }
}

/**
 * True when the caller is an unrestricted mail administrator.
 *
 * Mirrors the RBAC wildcard conventions used by `authorize.can()` and adds the
 * mail-administration grants seeded by migration 0169. Only `mail_admin.manage`
 * confers unrestricted rights: `mail_admin.view` is a read-only configuration
 * grant and deliberately does not open every mailbox.
 */
export function isMailAdmin(permissions: readonly string[] | undefined): boolean {
  if (!permissions) return false;
  return (
    permissions.includes('*') ||
    permissions.includes('system.admin.all') ||
    permissions.includes('communication.*') ||
    permissions.includes('communication.admin') ||
    permissions.includes('communication.mailboxes.admin') ||
    permissions.includes('communication.mail_admin.manage') ||
    permissions.includes('communication.mail_admin.*')
  );
}

/**
 * Mark active delegations whose window has closed as EXPIRED.
 *
 * Expiry is enforced here (not only by a cron) so a stale ACTIVE row can never
 * grant access: every access resolution runs this first. Cheaper than a
 * background sweep and correct even if the scheduler is down.
 */
export async function expireMailDelegations(
  client: pg.PoolClient,
  tenantId: number
): Promise<number> {
  const res = await client.query(
    `UPDATE mailbox_delegations
        SET status = 'EXPIRED', updated_at = now()
      WHERE tenant_id = $1 AND status = 'ACTIVE' AND ends_at <= now()`,
    [tenantId]
  );
  return res.rowCount ?? 0;
}

const MEMBER_SELECT = `
  SELECT m.mailbox_id, m.user_id, m.member_role, m.can_view, m.can_send, m.can_reply,
         m.can_delete, m.can_archive, m.can_delegate, m.can_export, m.can_admin
    FROM mailbox_members m
   WHERE m.user_id = $2 AND m.is_active = true
     AND m.mailbox_id = ANY($1::bigint[])`;

/** Rows of membership + delegation permissions for the caller, keyed by mailbox id. */
async function loadGrants(
  client: pg.PoolClient,
  tenantId: number,
  userId: number,
  mailboxIds: number[]
): Promise<{
  members: Map<number, Record<string, unknown>>;
  delegations: Map<number, Record<string, unknown>>;
}> {
  const members = new Map<number, Record<string, unknown>>();
  const delegations = new Map<number, Record<string, unknown>>();
  if (mailboxIds.length === 0) return { members, delegations };

  const memberRows = await client.query(MEMBER_SELECT, [mailboxIds, userId]);
  for (const row of memberRows.rows) members.set(Number(row.mailbox_id), row);

  const delegationRows = await client.query(
    `SELECT d.*, u.first_name, u.last_name
       FROM mailbox_delegations d
       LEFT JOIN users u ON u.id = d.delegator_user_id
      WHERE d.tenant_id = $1 AND d.delegate_user_id = $2
        AND d.status = 'ACTIVE' AND d.starts_at <= now() AND d.ends_at > now()
        AND d.mailbox_id = ANY($3::bigint[])`,
    [tenantId, userId, mailboxIds]
  );
  for (const row of delegationRows.rows) delegations.set(Number(row.mailbox_id), row);
  return { members, delegations };
}

function fullPermissions(): MailboxPermissions {
  return {
    canView: true,
    canSend: true,
    canReply: true,
    canDelete: true,
    canArchive: true,
    canDelegate: true,
    canExport: true,
    canAdmin: true,
  };
}

function permissionsFromMember(row: Record<string, unknown>): MailboxPermissions {
  return {
    canView: truthy(row.can_view),
    canSend: truthy(row.can_send),
    canReply: truthy(row.can_reply),
    canDelete: truthy(row.can_delete),
    canArchive: truthy(row.can_archive),
    canDelegate: truthy(row.can_delegate),
    canExport: truthy(row.can_export),
    canAdmin: truthy(row.can_admin),
  };
}

function permissionsFromDelegation(row: Record<string, unknown>): MailboxPermissions {
  const perms = { ...NO_MAILBOX_PERMISSIONS };
  const raw = row.permissions;
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.replace(/[[\]"]/g, ' ').split(/[,\s]+/).filter(Boolean)
      : [];
  for (const token of tokens) {
    const flag = flagForToken(token);
    if (flag) perms[flag] = true;
  }
  // A delegation always implies read access; sending requires the token or the
  // explicit on-behalf flag so a read-only delegation cannot impersonate.
  perms.canView = true;
  if (truthy(row.can_send_on_behalf)) perms.canSend = true;
  return perms;
}

const mergePermissions = (...sets: MailboxPermissions[]): MailboxPermissions => {
  const out = { ...NO_MAILBOX_PERMISSIONS };
  for (const set of sets) {
    for (const key of Object.keys(out) as MailboxPermissionFlag[]) {
      if (set[key]) out[key] = true;
    }
  }
  return out;
};

/**
 * Every mailbox the caller may open, with effective permissions resolved from
 * membership plus any live delegation. Administrators see all active mailboxes.
 */
export async function listMailboxesForUser(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined
): Promise<MailboxAccess[]> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  if (!tenantId || !userId) return [];
  await expireMailDelegations(client, tenantId);

  const globalAdmin = isMailAdmin(permissions);
  const scope: string[] = ['mb.tenant_id = $1', 'mb.is_active = true'];
  const params: unknown[] = [tenantId];
  if (!globalAdmin) {
    params.push(userId);
    scope.push(`(
      mb.owner_user_id = $${params.length}
      OR EXISTS (SELECT 1 FROM mailbox_members m
                  WHERE m.mailbox_id = mb.id AND m.user_id = $${params.length} AND m.is_active = true)
      OR EXISTS (SELECT 1 FROM mailbox_delegations d
                  WHERE d.mailbox_id = mb.id AND d.delegate_user_id = $${params.length}
                    AND d.status = 'ACTIVE' AND d.starts_at <= now() AND d.ends_at > now())
    )`);
  }
  const rows = await client.query(
    `SELECT mb.* FROM mailboxes mb WHERE ${scope.join(' AND ')} ORDER BY mb.kind, mb.display_name`,
    params
  );
  const ids = rows.rows.map((r) => Number(r.id));
  const { members, delegations } = await loadGrants(client, tenantId, userId, ids);

  return rows.rows.map((mailbox) => {
    const id = Number(mailbox.id);
    const member = members.get(id);
    const delegation = delegations.get(id);
    const perms = globalAdmin
      ? fullPermissions()
      : mergePermissions(
          member ? permissionsFromMember(member) : NO_MAILBOX_PERMISSIONS,
          delegation ? permissionsFromDelegation(delegation) : NO_MAILBOX_PERMISSIONS
        );
    const delegatorName = delegation
      ? [delegation.first_name, delegation.last_name].filter(Boolean).join(' ').trim() || null
      : null;
    return {
      ...perms,
      mailboxId: id,
      mailbox,
      memberRole: member ? String(member.member_role ?? 'MEMBER') : null,
      viaDelegation: Boolean(delegation),
      delegationId: delegation ? Number(delegation.id) : null,
      onBehalfOfUserId: delegation ? Number(delegation.delegator_user_id) : null,
      onBehalfOfName: delegatorName,
      globalAdmin,
    };
  });
}

/**
 * Resolve the caller's access to one mailbox. Throws 404 when the mailbox does
 * not exist in the tenant and 403 when it exists but the caller may not open it
 * (the message never confirms the mailbox exists to an unauthorised caller).
 */
export async function resolveMailboxAccess(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  mailboxId: number
): Promise<MailboxAccess> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  if (!mailboxId) throw badRequestMailbox();
  await expireMailDelegations(client, tenantId);

  const row = await client.query(
    `SELECT * FROM mailboxes WHERE id = $1 AND tenant_id = $2`,
    [mailboxId, tenantId]
  );
  if (row.rows.length === 0) throw notFound('Mailbox not found');
  const mailbox = row.rows[0] as Record<string, unknown>;

  const globalAdmin = isMailAdmin(permissions);
  const { members, delegations } = await loadGrants(client, tenantId, userId, [mailboxId]);
  const member = members.get(mailboxId);
  const delegation = delegations.get(mailboxId);

  const isOwner = Number(mailbox.owner_user_id) === userId && userId > 0;
  if (!globalAdmin && !member && !delegation && !isOwner) {
    throw forbidden('You do not have access to this mailbox');
  }
  const perms = globalAdmin
    ? fullPermissions()
    : mergePermissions(
        member
          ? permissionsFromMember(member)
          : isOwner
            ? fullPermissions()
            : NO_MAILBOX_PERMISSIONS,
        delegation ? permissionsFromDelegation(delegation) : NO_MAILBOX_PERMISSIONS
      );
  if (!globalAdmin && isOwner && !member) {
    // Owner keeps administrative control of their own mailbox.
    Object.assign(perms, fullPermissions());
  }
  const delegatorName = delegation
    ? [delegation.first_name, delegation.last_name].filter(Boolean).join(' ').trim() || null
    : null;
  return {
    ...perms,
    mailboxId,
    mailbox,
    memberRole: member ? String(member.member_role ?? 'MEMBER') : isOwner ? 'OWNER' : null,
    viaDelegation: Boolean(delegation),
    delegationId: delegation ? Number(delegation.id) : null,
    onBehalfOfUserId: delegation ? Number(delegation.delegator_user_id) : null,
    onBehalfOfName: delegatorName,
    globalAdmin,
  };
}

function badRequestMailbox() {
  return notFound('Mailbox not found');
}

/** Throw 403 unless the resolved access carries the flag. */
export function assertMailboxPermission(
  access: MailboxAccess,
  flag: MailboxPermissionFlag,
  message: string
): void {
  if (!access[flag]) throw forbidden(message);
}

/**
 * Resolve the mailbox a message belongs to without leaking existence: callers
 * must already hold the row (e.g. from an authorised list query).
 */
export function mailboxIdOf(email: Record<string, unknown>): number | null {
  const id = Number(email.mailbox_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}
