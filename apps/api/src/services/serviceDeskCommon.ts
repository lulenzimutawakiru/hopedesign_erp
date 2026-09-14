import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, forbidden, idIn, isNumericRef, notFound, parsePagination, sameId } from '../utils.js';
import { logAudit } from './audit.js';
import { createNotification } from './notifications.js';
import { emitEvent } from './events.js';
import { resolveScope, type TicketScope } from './serviceDesk.js';

/**
 * Shared helpers for the Service Desk service modules (knowledge, problems,
 * changes, access requests, assets). The ticket module keeps its own private
 * copies because it owns the aggregate; every module added on top of it shares
 * these so validation and scope semantics cannot drift apart.
 */

export { resolveScope, type TicketScope };
export { logAudit, createNotification, emitEvent };
export { badRequest, conflict, forbidden, idIn, isNumericRef, notFound, parsePagination, sameId };
export type { Ctx };

export const s = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  return t === '' ? undefined : t;
};

export const n = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

export const nn = (v: unknown): number | null => {
  const x = n(v);
  return x === undefined ? null : x;
};

export const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';

export const oneOf = <T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined => {
  const t = s(v);
  if (!t) return undefined;
  const up = t.toUpperCase();
  return (allowed as readonly string[]).includes(up) ? (up as T[number]) : undefined;
};

export const uniq = <T>(arr: T[]): T[] => Array.from(new Set(arr));

/** Parse a comma separated string or a JSON array into a clean string list. */
export const strList = (v: unknown): string[] | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (Array.isArray(v)) {
    return uniq(v.map((x) => String(x).trim()).filter(Boolean));
  }
  const t = String(v).trim();
  if (!t) return [];
  return uniq(t.split(',').map((x) => x.trim()).filter(Boolean));
};

/** Match a permission either exactly, as a wildcard child, or via a global grant. */
export const hasPerm = (perms: string[], code: string): boolean =>
  perms.includes('*') || perms.includes(code) || perms.includes(`${code}.*`);

/** Human-readable timestamp used in generated notes. */
export const nowIso = (): string => new Date().toISOString();

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  offset: number;
}

/** Standard paged result envelope shared by every Service Desk list endpoint. */
export function paged<T>(items: T[], total: number, page: number, limit: number, offset: number): Page<T> {
  return { items, total, page, limit, offset };
}

/** Assert a row exists, with a module-appropriate message. */
export function requireRow<T>(row: T | undefined | null, message: string): T {
  if (row === undefined || row === null) throw notFound(message);
  return row;
}

/** Email + display name for a user id, or null when unset. */
export async function userContact(
  client: pg.PoolClient,
  ctx: Ctx,
  userId: number | null | undefined
): Promise<{ id: number; email: string } | null> {
  if (!userId) return null;
  const r = await client.query<{ id: number; email: string }>(
    `SELECT id, email FROM users WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
    [userId, ctx.companyId]
  );
  return r.rows[0] ?? null;
}

/** Notify a set of users, skipping the acting user and duplicates. */
export async function notifyUsers(
  client: pg.PoolClient,
  ctx: Ctx,
  userIds: Array<number | null | undefined>,
  payload: {
    type: string;
    title: string;
    body?: string;
    link?: string;
    entityType?: string | null;
    entityId?: number | null;
    severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  }
) {
  const targets = uniq(
    userIds.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
  ).filter((id) => id !== ctx.userId);
  for (const userId of targets) {
    await createNotification(client, ctx, {
      userId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      entityType: payload.entityType ?? null,
      entityId: payload.entityId ?? null,
      severity: payload.severity ?? 'INFO',
    });
  }
}

/** Active users holding a permission, so approval queues can be routed. */
export async function usersWithPermission(
  client: pg.PoolClient,
  ctx: Ctx,
  code: string
): Promise<number[]> {
  const res = await client.query<{ id: number }>(
    `SELECT DISTINCT ur.user_id AS id
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN users u ON u.id = ur.user_id
      WHERE p.code = $1 AND u.status = 'ACTIVE'
        AND (u.company_id = $2 OR u.company_id IS NULL)`,
    [code, ctx.companyId]
  );
  return res.rows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
}
