import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, badRequest, notFound, parsePagination, toCamelRows, toCamelRow } from '../utils.js';

export const notificationsRouter = Router();

function ownWhere(unread?: unknown, urgent?: unknown, q?: unknown) {
  const where: string[] = ['n.user_id = $1', 'n.tenant_id = $2', 'n.archived_at IS NULL', '(n.snoozed_until IS NULL OR n.snoozed_until <= now())'];
  const params: unknown[] = [];
  if (unread === 'true') where.push('n.read_at IS NULL');
  if (urgent === 'true') where.push("n.priority IN ('CRITICAL','URGENT')");
  if (typeof q === 'string' && q.trim()) {
    params.push(`%${q.trim()}%`);
    where.push(`(n.title ILIKE $${2 + params.length} OR n.body ILIKE $${2 + params.length})`);
  }
  return { where, extra: params };
}

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const { where, extra } = ownWhere(req.query.unread, req.query.urgent, req.query.q);
    const params: unknown[] = [req.auth!.id, req.auth!.tenant_id, ...extra];
    const sql =
      `SELECT n.*, COUNT(*) OVER() AS _total FROM notifications n ` +
      `WHERE ${where.join(' AND ')} ` +
      `ORDER BY CASE n.priority WHEN 'CRITICAL' THEN 0 WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END, n.created_at DESC ` +
      `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const res2 = await query(sql, [...params, pageSize, offset], req.ctx);
    const total = res2.rows.length ? Number(res2.rows[0]._total) : 0;
    const rows = toCamelRows(
      res2.rows.map((row) => {
        const { _total, ...rest } = row as Record<string, unknown>;
        return rest;
      })
    );
    res.json({ data: { rows, pagination: { page, pageSize, total } } });
  })
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const res2 = await query(
      `SELECT count(*)::int AS count FROM notifications
       WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL
         AND archived_at IS NULL
         AND (snoozed_until IS NULL OR snoozed_until <= now())`,
      [req.auth!.id, req.auth!.tenant_id],
      req.ctx
    );
    res.json({ count: Number(res2.rows[0].count) });
  })
);

async function mutateOwn(
  req: import('express').Request,
  id: number,
  sql: string,
  extra: unknown[] = []
) {
  const res2 = await query(
    sql,
    [id, req.auth!.id, req.auth!.tenant_id, ...extra],
    req.ctx
  );
  if (res2.rows.length === 0) throw notFound('Notification not found');
  return toCamelRow(res2.rows[0] as Record<string, unknown>);
}

notificationsRouter.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json({
      data: await mutateOwn(
        req,
        id,
        `UPDATE notifications SET read_at = COALESCE(read_at, now())
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`
      ),
    });
  })
);

notificationsRouter.patch(
  '/:id/unread',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json({
      data: await mutateOwn(
        req,
        id,
        `UPDATE notifications SET read_at = NULL
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`
      ),
    });
  })
);

notificationsRouter.patch(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json({
      data: await mutateOwn(
        req,
        id,
        `UPDATE notifications SET archived_at = COALESCE(archived_at, now())
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`
      ),
    });
  })
);

notificationsRouter.patch(
  '/:id/snooze',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const until = req.body?.until ? new Date(String(req.body.until)) : null;
    if (!until || Number.isNaN(until.getTime())) throw badRequest('until is required as an ISO date');
    res.json({
      data: await mutateOwn(
        req,
        id,
        `UPDATE notifications SET snoozed_until = $4
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
        [until.toISOString()]
      ),
    });
  })
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const res2 = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL`,
      [req.auth!.id, req.auth!.tenant_id],
      req.ctx
    );
    res.json({ data: { updated: res2.rowCount ?? 0 } });
  })
);
