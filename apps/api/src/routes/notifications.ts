import { Router } from 'express';
import { query } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, notFound, parsePagination, toCamelRows, toCamelRow } from '../utils.js';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  requirePermission('notifications.notifications.view'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const where: string[] = ['n.user_id = $1', 'n.tenant_id = $2'];
    const params: unknown[] = [req.auth!.id, req.auth!.tenant_id];
    if (req.query.unread === 'true') where.push('n.read_at IS NULL');
    const sql =
      `SELECT n.*, COUNT(*) OVER() AS _total FROM notifications n ` +
      `WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC ` +
      `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const res2 = await query(sql, [...params, pageSize, offset], req.ctx);
    const total = res2.rows.length ? Number(res2.rows[0]._total) : 0;
    const rows = res2.rows.map((row) => {
      const { _total, ...rest } = row;
      return toCamelRow(rest as Record<string, unknown>);
    });
    res.json({ data: rows, pagination: { page, pageSize, total } });
  })
);

notificationsRouter.get(
  '/unread-count',
  requirePermission('notifications.notifications.view'),
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

notificationsRouter.patch(
  '/:id/read',
  requirePermission('notifications.notifications.read'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const res2 = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, req.auth!.id, req.auth!.tenant_id],
      req.ctx
    );
    if (res2.rows.length === 0) throw notFound('Notification not found');
    res.json({ data: toCamelRow(res2.rows[0] as Record<string, unknown>) });
  })
);
