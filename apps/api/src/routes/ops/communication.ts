import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import {
  asyncHandler,
  badRequest,
  notFound,
  parsePagination,
  toCamelRow,
  toCamelRows,
} from '../../utils.js';
import {
  auditComms,
  notifyUsers,
  renderEmailForSend,
  renderTemplate,
} from '../../services/communication.js';
import { sendEmail, sendSms, sendWhatsApp, type ProviderOverride } from '../../services/bird.js';
import { messagingLimiter } from '../../middleware/rateLimits.js';

export const communicationOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
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

// ---------------------------------------------------------------------------
// Command center
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/command',
  ...runGet('communication.command.view', async (c, ctx) => {
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const urgent = await c.query(
      `SELECT count(*)::int AS value FROM notifications
        WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL
          AND priority IN ('URGENT','CRITICAL')`,
      [uid, tenantId]
    );
    const unread = await c.query(
      `SELECT count(*)::int AS value
         FROM conversation_messages m
         JOIN conversation_members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = $1
        WHERE m.tenant_id = $2 AND m.sender_id <> $1
          AND (mb.last_read_at IS NULL OR m.created_at > mb.last_read_at)`,
      [uid, tenantId]
    );
    const convos = await c.query(
      `SELECT count(*)::int AS value FROM conversation_members
        WHERE user_id = $1 AND tenant_id = $2`,
      [uid, tenantId]
    );
    const approvals = await c.query(
      `SELECT count(*)::int AS value FROM approval_tasks t
        WHERE t.status = 'PENDING'
          AND (t.approver_user_id = $1 OR EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                 WHERE ur.user_id = $1 AND r.id = t.approver_role_id))`,
      [uid]
    );
    const deliveries = await c.query(
      `SELECT count(*)::int AS value FROM notification_deliveries
        WHERE user_id = $1 AND tenant_id = $2 AND status IN ('QUEUED','SENT','RETRYING')`,
      [uid, tenantId]
    );
    return {
      kpis: {
        urgentNotifications: Number(urgent.rows[0].value),
        unreadMessages: Number(unread.rows[0].value),
        activeConversations: Number(convos.rows[0].value),
        pendingApprovals: Number(approvals.rows[0].value),
        pendingDeliveries: Number(deliveries.rows[0].value),
      },
    };
  })
);

// ---------------------------------------------------------------------------
// People directory (for starting conversations / adding members)
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/people',
  ...runGet('communication.messages.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const uid = ctx.userId ?? 0;
    const term = q.q ? '%' + String(q.q) + '%' : null;
    const { rows } = await c.query(
      'SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.job_title, ' +
        'd.name AS department_name ' +
        'FROM users u ' +
        'LEFT JOIN departments d ON d.id = u.department_id ' +
        'WHERE u.tenant_id = $1 AND u.status = ' + "'" + 'ACTIVE' + "'" + ' AND u.id <> $2 ' +
        'AND ($3::text IS NULL OR u.first_name ILIKE $3 OR u.last_name ILIKE $3 ' +
        'OR u.username ILIKE $3 OR u.email ILIKE $3) ' +
        'ORDER BY u.first_name, u.last_name ' +
        'LIMIT 200',
      [tenantId, uid, term]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/channels',
  ...runGet('communication.messages.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const uid = ctx.userId ?? 0;
    const search = q.q ? `%${String(q.q)}%` : null;
    const { rows } = await c.query(
      `SELECT ch.*,
              (SELECT count(*)::int FROM channel_members cm WHERE cm.channel_id = ch.id) AS member_count,
              EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $2) AS is_member
         FROM communication_channels ch
        WHERE ch.tenant_id = $1 AND ($3::text IS NULL OR ch.name ILIKE $3 OR ch.code ILIKE $3 OR ch.description ILIKE $3)
        ORDER BY ch.is_default DESC, ch.name`,
      [tenantId, uid, search]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.get(
  '/channels/:id',
  ...runGet('communication.messages.view', async (c, ctx, _q, p) => {
    const tenantId = ctx.tenantId ?? 0;
    const channelId = Number(p.id);
    const ch = await c.query(
      `SELECT * FROM communication_channels WHERE id = $1 AND tenant_id = $2`,
      [channelId, tenantId]
    );
    if (ch.rows.length === 0) throw notFound('Channel not found');
    const members = await c.query(
      `SELECT cm.*, u.username, u.email, u.first_name, u.last_name, u.job_title
         FROM channel_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = $1 ORDER BY cm.joined_at`,
      [channelId]
    );
    return {
      ...toCamelRow(ch.rows[0] as Record<string, unknown>),
      members: toCamelRows(members.rows as Record<string, unknown>[]),
    };
  })
);

communicationOpsRouter.post(
  '/channels',
  messagingLimiter,
...run('communication.messages.manage', async (c, ctx, b) => {
    const code = String(b.code ?? '').trim().toUpperCase();
    const name = String(b.name ?? '').trim();
    if (!code || !name) throw badRequest('code and name are required');
    const { rows } = await c.query(
      `INSERT INTO communication_channels
         (tenant_id, company_id, branch_id, code, name, kind, description, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, code) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind, description = EXCLUDED.description,
         is_default = EXCLUDED.is_default, updated_at = now()
       RETURNING *`,
      [
        ctx.tenantId ?? 0,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        code,
        name,
        String(b.kind ?? 'DEPT').toUpperCase(),
        b.description ?? null,
        !!b.isDefault,
        ctx.userId ?? null,
      ]
    );
    const ch = rows[0];
    await c.query(
      `INSERT INTO channel_members (tenant_id, channel_id, user_id, role)
       VALUES ($1,$2,$3,'OWNER') ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [ctx.tenantId ?? 0, ch.id, ctx.userId ?? 0]
    );
    await auditComms(c, ctx, 'CHANNEL_CREATED', 'communication_channel', Number(ch.id), { code, name });
    return toCamelRow(ch as Record<string, unknown>);
  })
);

communicationOpsRouter.post(
  '/channels/:id/members',
  ...run('communication.messages.manage', async (c, ctx, b, p) => {
    const channelId = Number(p.id);
    const userId = NUM(b.userId);
    if (!userId) throw badRequest('userId is required');
    const { rows } = await c.query(
      `INSERT INTO channel_members (tenant_id, channel_id, user_id, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [ctx.tenantId ?? 0, channelId, userId, String(b.role ?? 'MEMBER').toUpperCase()]
    );
    await auditComms(c, ctx, 'CHANNEL_MEMBER_ADDED', 'communication_channel', channelId, { userId });
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.delete(
  '/channels/:id/members/:userId',
  ...run('communication.messages.manage', async (c, ctx, _b, p) => {
    const channelId = Number(p.id);
    const userId = Number(p.userId);
    await c.query(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, [channelId, userId]);
    await auditComms(c, ctx, 'CHANNEL_MEMBER_REMOVED', 'communication_channel', channelId, { userId });
    return { ok: true };
  })
);
// ---------------------------------------------------------------------------
// Conversations + messages
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/conversations',
  ...runGet('communication.messages.view', async (c, ctx, q) => {
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const kind = q.kind ? String(q.kind).toUpperCase() : null;
    const { rows } = await c.query(
      `SELECT cv.*,
              (SELECT body FROM conversation_messages m
                WHERE m.conversation_id = cv.id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT count(*)::int FROM conversation_messages m
                WHERE m.conversation_id = cv.id AND m.sender_id <> $1 AND m.deleted_at IS NULL
                  AND (mb.last_read_at IS NULL OR m.created_at > mb.last_read_at)) AS unread_count
         FROM conversations cv
         JOIN conversation_members mb ON mb.conversation_id = cv.id AND mb.user_id = $1
        WHERE cv.tenant_id = $2 AND ($3::text IS NULL OR cv.kind = $3)
        ORDER BY COALESCE(cv.last_message_at, cv.updated_at) DESC`,
      [uid, tenantId, kind]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.post(
  '/conversations',
  messagingLimiter,
...run('communication.messages.send', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const kind = String(b.kind ?? 'DIRECT').toUpperCase();
    if (!['DIRECT', 'GROUP', 'CHANNEL', 'RECORD'].includes(kind)) throw badRequest('Invalid conversation kind');
    const userIds = Array.isArray(b.userIds)
      ? b.userIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    if (kind === 'DIRECT' && userIds.length !== 1) throw badRequest('DIRECT conversations require exactly one other userId');
    const channelId = NUM(b.channelId);
    if (kind === 'CHANNEL') {
      const ch = await c.query(
        `SELECT id FROM communication_channels WHERE id = $1 AND tenant_id = $2`,
        [channelId, tenantId]
      );
      if (ch.rows.length === 0) throw badRequest('channelId must reference an existing channel');
    }
    const { rows } = await c.query(
      `INSERT INTO conversations
         (tenant_id, company_id, branch_id, kind, title, entity_type, entity_id, channel_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        tenantId,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        kind,
        b.title ? String(b.title) : null,
        b.entityType ?? null,
        NUM(b.entityId),
        channelId,
        ctx.userId ?? null,
      ]
    );
    const conv = rows[0];
    const members = new Set<number>([ctx.userId ?? 0, ...userIds]);
    for (const uid of members) {
      await c.query(
        `INSERT INTO conversation_members (tenant_id, conversation_id, user_id, role)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [tenantId, conv.id, uid, uid === (ctx.userId ?? 0) ? 'OWNER' : 'MEMBER']
      );
    }
    await auditComms(c, ctx, 'CONVERSATION_CREATED', 'conversation', Number(conv.id), { kind, title: b.title ?? null });
    return toCamelRow(conv as Record<string, unknown>);
  })
);

communicationOpsRouter.get(
  '/conversations/:id',
  ...runGet('communication.messages.view', async (c, ctx, _q, p) => {
    const convId = Number(p.id);
    const uid = ctx.userId ?? 0;
    const member = await c.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [convId, uid]
    );
    if (member.rows.length === 0) throw notFound('Conversation not found');
    const conv = await c.query(`SELECT * FROM conversations WHERE id = $1`, [convId]);
    const members = await c.query(
      `SELECT cm.*, u.username, u.email, u.first_name, u.last_name, u.job_title
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 ORDER BY cm.joined_at`,
      [convId]
    );
    return {
      ...toCamelRow(conv.rows[0] as Record<string, unknown>),
      members: toCamelRows(members.rows as Record<string, unknown>[]),
    };
  })
);

communicationOpsRouter.get(
  '/conversations/:id/messages',
  ...runGet('communication.messages.view', async (c, ctx, q, p) => {
    const convId = Number(p.id);
    const uid = ctx.userId ?? 0;
    const member = await c.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [convId, uid]
    );
    if (member.rows.length === 0) throw notFound('Conversation not found');
    const { pageSize, offset } = parsePagination(q);
    const { rows } = await c.query(
      `SELECT m.*, u.username, u.first_name, u.last_name, u.email, u.job_title,
              COALESCE((SELECT json_agg(r.reaction) FROM message_reactions r WHERE r.message_id = m.id), '[]'::json) AS reactions
         FROM conversation_messages m
         JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT $2 OFFSET $3`,
      [convId, pageSize, offset]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.post(
  '/conversations/:id/messages',
  messagingLimiter,
...run('communication.messages.send', async (c, ctx, b, p) => {
    const convId = Number(p.id);
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const member = await c.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [convId, uid]
    );
    if (member.rows.length === 0) throw notFound('Conversation not found');
    const body = String(b.body ?? '').trim();
    if (!body) throw badRequest('message body is required');
    const { rows } = await c.query(
      `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_id, body, message_type, reply_to)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, convId, uid, body, b.messageType ?? 'TEXT', NUM(b.replyTo)]
    );
    const msg = rows[0];
    await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [convId]);
    await c.query(
      `INSERT INTO message_reads (tenant_id, message_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, msg.id, uid]
    );

    // @mention detection across active tenant users (exclude sender).
    const users = await c.query(
      `SELECT id, username FROM users WHERE tenant_id = $1 AND status = 'ACTIVE' AND id <> $2`,
      [tenantId, uid]
    );
    const mentioned = new Set<number>();
    for (const u of users.rows as { id: string; username: string }[]) {
      const esc = String(u.username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`@${esc}\\b`, 'i').test(body)) mentioned.add(Number(u.id));
    }
    if (mentioned.size > 0) {
      await notifyUsers(c, ctx, {
        type: 'MESSAGE_MENTION',
        title: 'You were mentioned in a message',
        body: body.length > 140 ? body.slice(0, 140) + '…' : body,
        link: `/#/communication/messages/${convId}`,
        entityType: 'conversation',
        entityId: convId,
        priority: 'HIGH',
        actionLabel: 'View message',
        actionTarget: `/#/communication/messages/${convId}`,
      }, [...mentioned]);
      for (const mid of mentioned) {
        await c.query(
          `INSERT INTO message_mentions (tenant_id, message_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [tenantId, msg.id, mid]
        );
      }
    }

    // Notify other conversation members (excluding sender and already-mentioned).
    const others = await c.query(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
      [convId, uid]
    );
    const otherIds = (others.rows as { user_id: string }[])
      .map((r) => Number(r.user_id))
      .filter((n: number) => !mentioned.has(n));
    if (otherIds.length > 0) {
      await notifyUsers(c, ctx, {
        type: 'MESSAGE_RECEIVED',
        title: 'New message',
        body: body.length > 140 ? body.slice(0, 140) + '…' : body,
        link: `/#/communication/messages/${convId}`,
        entityType: 'conversation',
        entityId: convId,
        priority: 'NORMAL',
        actionLabel: 'Open chat',
        actionTarget: `/#/communication/messages/${convId}`,
      }, otherIds);
    }
    await auditComms(c, ctx, 'MESSAGE_SENT', 'conversation_message', Number(msg.id), { conversationId: convId });
    const sender = await c.query(
      `SELECT username, first_name, last_name, email, job_title FROM users WHERE id = $1`,
      [uid]
    );
    return {
      ...toCamelRow(msg as Record<string, unknown>),
      ...toCamelRow(sender.rows[0] as Record<string, unknown>),
    };
  })
);

communicationOpsRouter.post(
  '/conversations/:id/read',
  ...run('communication.messages.send', async (c, ctx, _b, p) => {
    const convId = Number(p.id);
    const uid = ctx.userId ?? 0;
    await c.query(
      `INSERT INTO message_reads (tenant_id, message_id, user_id)
       SELECT tenant_id, id, $2 FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id <> $2 AND deleted_at IS NULL
       ON CONFLICT DO NOTHING`,
      [convId, uid]
    );
    await c.query(
      `UPDATE conversation_members SET last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [convId, uid]
    );
    await auditComms(c, ctx, 'CONVERSATION_READ', 'conversation', convId);
    return { ok: true };
  })
);

communicationOpsRouter.get(
  '/messages/search',
  ...runGet('communication.messages.view', async (c, ctx, q) => {
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const term = q.q ? `%${String(q.q)}%` : null;
    if (!term) return [];
    const { rows } = await c.query(
      `SELECT m.*, cv.title AS conversation_title, u.username, u.first_name, u.last_name, u.email
         FROM conversation_messages m
         JOIN conversations cv ON cv.id = m.conversation_id
         JOIN conversation_members mb ON mb.conversation_id = cv.id AND mb.user_id = $1
         JOIN users u ON u.id = m.sender_id
        WHERE m.tenant_id = $2 AND m.deleted_at IS NULL AND m.body ILIKE $3
        ORDER BY m.created_at DESC LIMIT 50`,
      [uid, tenantId, term]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);
// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/notifications',
  ...runGet('communication.notifications.view', async (c, ctx, q) => {
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const { page, pageSize, offset } = parsePagination(q);
    const where = ['n.user_id = $1', 'n.tenant_id = $2'];
    const params: unknown[] = [uid, tenantId];
    if (q.archived !== 'true') {
      where.push('n.archived_at IS NULL');
      where.push('(n.snoozed_until IS NULL OR n.snoozed_until <= now())');
    }
    if (q.urgent === 'true') {
      where.push("n.priority IN ('CRITICAL','URGENT')");
    } else if (q.priority) {
      params.push(String(q.priority).toUpperCase());
      where.push(`n.priority = $${params.length}`);
    }
    if (q.type) {
      params.push(String(q.type).toUpperCase());
      where.push(`n.type = $${params.length}`);
    }
    if (q.unread === 'true') where.push('n.read_at IS NULL');
    if (q.q) {
      params.push(`%${String(q.q)}%`);
      where.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`);
    }
    const { rows } = await c.query(
      `SELECT n.*, COUNT(*) OVER() AS _total FROM notifications n
        WHERE ${where.join(' AND ')}
        ORDER BY CASE n.priority
                   WHEN 'CRITICAL' THEN 0 WHEN 'URGENT' THEN 1
                   WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
                 n.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );
    const total = rows.length ? Number(rows[0]._total) : 0;
    return {
      rows: toCamelRows(rows.map((r) => stripTotal(r as Record<string, unknown>))),
      pagination: { page, pageSize, total },
    };
  })
);
communicationOpsRouter.patch(
  '/notifications/:id/read',
  ...run('communication.notifications.read', async (c, ctx, _b, p) => {
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, ctx.userId ?? 0, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Notification not found');
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.patch(
  '/notifications/:id/acknowledge',
  ...run('communication.notifications.read', async (c, ctx, _b, p) => {
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, now()), acknowledged_at = COALESCE(acknowledged_at, now())
        WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, ctx.userId ?? 0, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Notification not found');
    await auditComms(c, ctx, 'NOTIFICATION_ACKNOWLEDGED', 'notification', id);
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.post(
  '/notifications/read-all',
  ...run('communication.notifications.read', async (c, ctx) => {
    const { rowCount } = await c.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL`,
      [ctx.userId ?? 0, ctx.tenantId ?? 0]
    );
    return { updated: rowCount ?? 0 };
  })
);
communicationOpsRouter.patch(
  '/notifications/:id/unread',
  ...run('communication.notifications.read', async (c, ctx, _b, p) => {
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE notifications SET read_at = NULL
        WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, ctx.userId ?? 0, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Notification not found');
    await auditComms(c, ctx, 'NOTIFICATION_UNREAD', 'notification', id);
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.patch(
  '/notifications/:id/archive',
  ...run('communication.notifications.read', async (c, ctx, _b, p) => {
    const id = Number(p.id);
    const { rows } = await c.query(
      `UPDATE notifications
          SET archived_at = COALESCE(archived_at, now())
        WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, ctx.userId ?? 0, ctx.tenantId ?? 0]
    );
    if (rows.length === 0) throw notFound('Notification not found');
    await auditComms(c, ctx, 'NOTIFICATION_ARCHIVED', 'notification', id);
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.patch(
  '/notifications/:id/snooze',
  ...run('communication.notifications.read', async (c, ctx, b, p) => {
    const id = Number(p.id);
    const until = b.until ? new Date(String(b.until)) : null;
    if (!until || Number.isNaN(until.getTime())) throw badRequest('until is required as an ISO date');
    const { rows } = await c.query(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, now()), snoozed_until = $4
        WHERE id = $1 AND user_id = $2 AND tenant_id = $3 RETURNING *`,
      [id, ctx.userId ?? 0, ctx.tenantId ?? 0, until.toISOString()]
    );
    if (rows.length === 0) throw notFound('Notification not found');
    await auditComms(c, ctx, 'NOTIFICATION_SNOOZED', 'notification', id, { until: until.toISOString() });
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Communication summary (health + analytics aggregates)
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/summary',
  ...runGet('communication.command.view', async (c, ctx) => {
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const [messages, emails, notifications, deliveries, templates, channels, unread, urgent] = await Promise.all([
      c.query(`SELECT count(*)::int AS v FROM conversation_messages WHERE tenant_id = $1`, [tenantId]),
      c.query(`SELECT count(*)::int AS v FROM emails WHERE tenant_id = $1`, [tenantId]),
      c.query(`SELECT count(*)::int AS v FROM notifications WHERE user_id = $1 AND tenant_id = $2`, [uid, tenantId]),
      c.query(`SELECT status, count(*)::int AS v FROM notification_deliveries WHERE user_id = $1 AND tenant_id = $2 GROUP BY status`, [uid, tenantId]),
      c.query(`SELECT count(*)::int AS v FROM email_templates WHERE tenant_id = $1`, [tenantId]),
      c.query(`SELECT count(*)::int AS v FROM communication_channels WHERE tenant_id = $1`, [tenantId]),
      c.query(`SELECT count(*)::int AS v FROM notifications WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL AND archived_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now())`, [uid, tenantId]),
      c.query(`SELECT count(*)::int AS v FROM notifications WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL AND archived_at IS NULL AND priority IN ('URGENT','CRITICAL') AND (snoozed_until IS NULL OR snoozed_until <= now())`, [uid, tenantId]),
    ]);
    const deliveryByStatus: Record<string, number> = {};
    for (const r of deliveries.rows) deliveryByStatus[String(r.status)] = Number(r.v);
    return {
      totals: {
        messages: Number(messages.rows[0].v),
        emails: Number(emails.rows[0].v),
        notifications: Number(notifications.rows[0].v),
        templates: Number(templates.rows[0].v),
        channels: Number(channels.rows[0].v),
        unreadNotifications: Number(unread.rows[0].v),
        urgentNotifications: Number(urgent.rows[0].v),
      },
      deliveries: deliveryByStatus,
    };
  })
);
// ---------------------------------------------------------------------------
// Email centre
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/emails',
  ...runGet('communication.emails.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const { page, pageSize, offset } = parsePagination(q);
    const where = ['e.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q.direction) {
      params.push(String(q.direction).toUpperCase());
      where.push(`e.direction = $${params.length}`);
    }
    if (q.status) {
      params.push(String(q.status).toUpperCase());
      where.push(`e.status = $${params.length}`);
    }
    const { rows } = await c.query(
      `SELECT e.*,
              (SELECT count(*)::int FROM email_recipients er WHERE er.email_id = e.id) AS recipient_count,
              COUNT(*) OVER() AS _total,
              u.first_name || ' ' || u.last_name AS creator_name
         FROM emails e
         LEFT JOIN users u ON u.id = e.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );
    const total = rows.length ? Number(rows[0]._total) : 0;
    return {
      rows: toCamelRows(rows.map((r) => stripTotal(r as Record<string, unknown>))),
      pagination: { page, pageSize, total },
    };
  })
);

communicationOpsRouter.post(
  '/emails',
  messagingLimiter,
...run('communication.emails.send', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const subject = String(b.subject ?? '').trim();
    if (!subject) throw badRequest('subject is required');
    const asList = (v: unknown): string[] => {
      if (Array.isArray(v)) {
        return v
          .map(String)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      if (typeof v === 'string') {
        const trimmed = v.trim();
        return trimmed ? [trimmed] : [];
      }
      return [];
    };
    const to = asList(b.to);
    const cc = asList(b.cc);
    const bcc = asList(b.bcc);
    const { rows } = await c.query(
      `INSERT INTO emails
         (tenant_id, company_id, branch_id, thread_id, direction, subject, body, "to", cc, bcc,
          status, scheduled_at, entity_type, entity_id, template_code, template_vars, created_by)
       VALUES ($1,$2,$3,$4,'OUT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        tenantId,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        NUM(b.threadId),
        subject,
        b.body ?? null,
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(bcc),
        b.status ?? 'DRAFT',
        b.scheduledAt ?? null,
        b.entityType ?? null,
        NUM(b.entityId),
        b.templateCode ?? null,
        b.templateVars && typeof b.templateVars === 'object'
          ? JSON.stringify(b.templateVars)
          : null,
        ctx.userId ?? null,
      ]
    );
    const email = rows[0];
    for (const kind of ['TO', 'CC', 'BCC'] as const) {
      const list = kind === 'TO' ? to : kind === 'CC' ? cc : bcc;
      for (const addr of list) {
        await c.query(
          `INSERT INTO email_recipients (tenant_id, email_id, kind, email) VALUES ($1,$2,$3,$4)`,
          [tenantId, email.id, kind, addr]
        );
      }
    }
    await auditComms(c, ctx, 'EMAIL_COMPOSED', 'email', Number(email.id), { subject });
    return toCamelRow(email as Record<string, unknown>);
  })
);

communicationOpsRouter.post(
  '/emails/:id/send',
  messagingLimiter,
...run('communication.emails.send', async (c, ctx, _b, p) => {
    const id = Number(p.id);
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (rows.length === 0) throw notFound('Email not found');
    const email = rows[0] as Record<string, unknown>;
    const scheduledAt = email.scheduled_at ? new Date(String(email.scheduled_at)) : null;
    if (scheduledAt && scheduledAt.getTime() > Date.now()) {
      await c.query(
        `UPDATE emails SET status = 'SCHEDULED', updated_at = now() WHERE id = $1`,
        [id]
      );
      await auditComms(c, ctx, 'EMAIL_SCHEDULED', 'email', id, { scheduledAt: scheduledAt.toISOString() });
      return toCamelRow({ ...email, status: 'SCHEDULED' } as Record<string, unknown>);
    }
    const toAddresses: string[] = [];
    const collect = (entry: unknown) => {
      if (typeof entry === 'string') {
        const addr = entry.trim();
        if (addr) toAddresses.push(addr);
      } else if (entry && typeof entry === 'object' && 'email' in entry) {
        const maybe = (entry as { email?: unknown }).email;
        if (typeof maybe === 'string') {
          const addr = maybe.trim();
          if (addr) toAddresses.push(addr);
        }
      }
    };
    // A re-send of a previously FAILED email must reactivate its recipients;
    // otherwise the post-send update below would have no QUEUED rows to update.
    await c.query(
      `UPDATE email_recipients SET status = 'QUEUED', error = NULL WHERE email_id = $1 AND kind = 'TO'`,
      [id]
    );
    // email_recipients is the authoritative recipient store; fall back to the
    // emails."to" JSON column when no recipient rows exist yet.
    const { rows: recRows } = await c.query(
      'SELECT email FROM email_recipients WHERE email_id = $1 AND kind = $2 AND status = $3 ORDER BY id ASC',
      [id, 'TO', 'QUEUED']
    );
    for (const row of recRows) collect(row.email);
    if (toAddresses.length === 0) {
      const rawTo = email.to;
      if (Array.isArray(rawTo)) {
        for (const entry of rawTo) collect(entry);
      } else if (rawTo != null && String(rawTo) !== '[]') {
        try {
          const parsed = JSON.parse(String(rawTo)) as unknown;
          if (Array.isArray(parsed)) {
            for (const entry of parsed) collect(entry);
          } else {
            collect(parsed);
          }
        } catch {
          // invalid JSON in "to" -> email marked failed below
        }
      }
    }
    const dedup = new Set<string>();
    const uniqueTo: string[] = [];
    for (const addr of toAddresses) {
      const key = addr.toLowerCase();
      if (!dedup.has(key)) {
        dedup.add(key);
        uniqueTo.push(addr);
      }
    }
    toAddresses.splice(0, toAddresses.length, ...uniqueTo);
    if (toAddresses.length === 0) {
      await c.query(
        `UPDATE emails SET status = 'FAILED', sent_at = now(), updated_at = now() WHERE id = $1`,
        [id]
      );
      await c.query(
        `UPDATE email_recipients SET status = 'FAILED', error = $2 WHERE email_id = $1 AND status = 'QUEUED'`,
        [id, 'No recipients']
      );
      await auditComms(c, ctx, 'EMAIL_SEND_FAILED', 'email', id, { error: 'No recipients' });
      throw badRequest('Email has no recipients');
    }
    // Render {{VAR}} placeholders server-side before dispatch so recipients
    // never see raw template tokens (template_vars + linked entity + company).
    const rendered = await renderEmailForSend(c, email);
    const subject = rendered.subject;
    const body = rendered.body;
    const result = await sendEmail({ to: toAddresses, subject, html: body, text: body });
    if (result.ok) {
      await c.query(
        `UPDATE emails SET status = 'SENT', sent_at = now(), subject = $2, body = $3, updated_at = now() WHERE id = $1`,
        [id, subject, body]
      );
      await c.query(
        `UPDATE email_recipients
            SET status = 'SENT', sent_at = now(), provider_message_id = $1, error = NULL
          WHERE email_id = $2 AND status = 'QUEUED'`,
        [result.providerMessageId ?? null, id]
      );
      await auditComms(c, ctx, 'EMAIL_SENT', 'email', id, { providerMessageId: result.providerMessageId ?? null });
      return toCamelRow({ ...email, status: 'SENT', subject, body, sentAt: new Date().toISOString() } as Record<string, unknown>);
    }
    await c.query(
      `UPDATE emails SET status = 'FAILED', sent_at = now(), subject = $2, body = $3, updated_at = now() WHERE id = $1`,
      [id, subject, body]
    );
    await c.query(
      `UPDATE email_recipients SET status = 'FAILED', error = $1 WHERE email_id = $2 AND status = 'QUEUED'`,
      [result.error ?? 'Sending failed', id]
    );
    await auditComms(c, ctx, 'EMAIL_SEND_FAILED', 'email', id, { error: result.error ?? null });
    return toCamelRow({ ...email, status: 'FAILED', subject, body, error: result.error ?? null } as Record<string, unknown>);
  })
);

communicationOpsRouter.get(
  '/emails/:id',
  ...runGet('communication.emails.view', async (c, ctx, _q, p) => {
    const id = Number(p.id);
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (rows.length === 0) throw notFound('Email not found');
    const recips = await c.query(
      `SELECT * FROM email_recipients WHERE email_id = $1 ORDER BY kind, created_at`,
      [id]
    );
    return {
      ...toCamelRow(rows[0] as Record<string, unknown>),
      recipients: toCamelRows(recips.rows as Record<string, unknown>[]),
    };
  })
);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/templates',
  ...runGet('communication.templates.view', async (c, ctx) => {
    const { rows } = await c.query(
      `SELECT * FROM email_templates WHERE tenant_id = $1 ORDER BY category, name`,
      [ctx.tenantId ?? 0]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.post(
  '/templates',
  ...run('communication.templates.manage', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const code = String(b.code ?? '').trim().toUpperCase();
    const name = String(b.name ?? '').trim();
    const subject = String(b.subject ?? '').trim();
    const body = String(b.body ?? '').trim();
    if (!code || !name || !subject || !body) throw badRequest('code, name, subject and body are required');
    const { rows } = await c.query(
      `INSERT INTO email_templates (tenant_id, company_id, code, name, category, subject, body, variables, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, code) DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category, subject = EXCLUDED.subject,
         body = EXCLUDED.body, variables = EXCLUDED.variables, is_active = EXCLUDED.is_active,
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        ctx.companyId ?? null,
        code,
        name,
        String(b.category ?? 'GENERAL').toUpperCase(),
        subject,
        body,
        JSON.stringify(Array.isArray(b.variables) ? b.variables : []),
        b.isActive !== false,
      ]
    );
    await auditComms(c, ctx, 'TEMPLATE_UPSERTED', 'email_template', Number(rows[0].id), { code });
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

communicationOpsRouter.post(
  '/templates/preview',
  ...run('communication.templates.view', async (c, ctx, b) => {
    const vars = (b.variables && typeof b.variables === 'object' ? b.variables : {}) as Record<string, unknown>;
    const code = String(b.code ?? '').trim();
    if (code) {
      const { rows } = await c.query(
        `SELECT subject, body FROM email_templates WHERE tenant_id = $1 AND code = $2`,
        [ctx.tenantId ?? 0, code]
      );
      if (rows.length === 0) throw notFound('Template not found');
      const t = rows[0] as { subject: string; body: string };
      return renderTemplate(t.subject, t.body, vars);
    }
    return renderTemplate(String(b.subject ?? ''), String(b.body ?? ''), vars);
  })
);
// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/announcements',
  ...runGet('communication.announcements.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const uid = ctx.userId ?? 0;
    const { page, pageSize, offset } = parsePagination(q);
    const { rows } = await c.query(
      `SELECT a.*,
              (ar.viewed_at IS NOT NULL) AS viewed,
              (ar.acknowledged_at IS NOT NULL) AS acknowledged,
              u.first_name || ' ' || u.last_name AS publisher_name,
              COUNT(*) OVER() AS _total
         FROM announcements a
         LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = $1
         LEFT JOIN users u ON u.id = a.published_by
        WHERE a.tenant_id = $2 AND (a.expires_at IS NULL OR a.expires_at > now())
        ORDER BY a.published_at DESC LIMIT $3 OFFSET $4`,
      [uid, tenantId, pageSize, offset]
    );
    const total = rows.length ? Number(rows[0]._total) : 0;
    return {
      rows: toCamelRows(rows.map((r) => stripTotal(r as Record<string, unknown>))),
      pagination: { page, pageSize, total },
    };
  })
);

communicationOpsRouter.post(
  '/announcements',
  ...run('communication.announcements.create', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const title = String(b.title ?? '').trim();
    const body = String(b.body ?? '').trim();
    if (!title || !body) throw badRequest('title and body are required');
    const { rows } = await c.query(
      `INSERT INTO announcements
         (tenant_id, company_id, branch_id, title, body, category, priority, audience,
          requires_ack, published_by, published_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11) RETURNING *`,
      [
        tenantId,
        ctx.companyId ?? null,
        ctx.branchId ?? null,
        title,
        body,
        String(b.category ?? 'GENERAL').toUpperCase(),
        String(b.priority ?? 'NORMAL').toUpperCase(),
        JSON.stringify(b.audience ?? {}),
        !!b.requiresAck,
        ctx.userId ?? null,
        b.expiresAt ?? null,
      ]
    );
    const ann = rows[0];
    const audience = (b.audience && typeof b.audience === 'object' ? b.audience : {}) as Record<string, unknown>;
    const roleCodes = Array.isArray(audience.roles) ? audience.roles.map(String) : [];
    const userIds = Array.isArray(audience.userIds)
      ? audience.userIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    let recipientSql = `SELECT id FROM users WHERE tenant_id = $1 AND status = 'ACTIVE'`;
    const rp: unknown[] = [tenantId];
    if (roleCodes.length > 0) {
      rp.push(roleCodes);
      recipientSql += ` AND id IN (SELECT ur.user_id FROM user_roles ur
                       JOIN roles r ON r.id = ur.role_id WHERE r.code = ANY($2::text[]))`;
    }
    if (userIds.length > 0) {
      rp.push(userIds);
      recipientSql += ` AND id = ANY($${rp.length}::bigint[])`;
    }
    const recips = await c.query(recipientSql, rp);
    for (const r of recips.rows as { id: string }[]) {
      await c.query(
        `INSERT INTO announcement_recipients (tenant_id, announcement_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [tenantId, ann.id, Number(r.id)]
      );
    }
    const notifyIds = (recips.rows as { id: string }[])
      .map((r) => Number(r.id))
      .filter((n: number) => n !== (ctx.userId ?? 0));
    if (notifyIds.length > 0) {
      await notifyUsers(c, ctx, {
        type: 'ANNOUNCEMENT',
        title,
        body: body.length > 160 ? body.slice(0, 160) + '…' : body,
        priority: (String(b.priority ?? 'NORMAL').toUpperCase()) as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL',
        actionLabel: 'Read announcement',
        actionTarget: '/#/communication/announcements',
        entityType: 'announcement',
        entityId: Number(ann.id),
      }, notifyIds);
    }
    await auditComms(c, ctx, 'ANNOUNCEMENT_PUBLISHED', 'announcement', Number(ann.id), { title });
    return toCamelRow(ann as Record<string, unknown>);
  })
);

communicationOpsRouter.post(
  '/announcements/:id/read',
  ...run('communication.announcements.view', async (c, ctx, b, p) => {
    const id = Number(p.id);
    const uid = ctx.userId ?? 0;
    const tenantId = ctx.tenantId ?? 0;
    const { rows } = await c.query(
      `INSERT INTO announcement_reads (tenant_id, announcement_id, user_id, viewed_at, acknowledged_at)
       VALUES ($1,$2,$3,now(), CASE WHEN $4 THEN now() ELSE NULL END)
       ON CONFLICT (announcement_id, user_id)
       DO UPDATE SET viewed_at = now(),
         acknowledged_at = CASE WHEN $4 THEN COALESCE(announcement_reads.acknowledged_at, now())
                                ELSE announcement_reads.acknowledged_at END
       RETURNING *`,
      [tenantId, id, uid, !!b.acknowledge]
    );
    return toCamelRow(rows[0] as Record<string, unknown>);
  })
);

// ---------------------------------------------------------------------------
// Delivery logs
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/deliveries',
  ...runGet('communication.delivery_logs.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const { page, pageSize, offset } = parsePagination(q);
    const where = ['d.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q.status) {
      params.push(String(q.status).toUpperCase());
      where.push(`d.status = $${params.length}`);
    }
    if (q.channel) {
      params.push(String(q.channel).toUpperCase());
      where.push(`d.channel = $${params.length}`);
    }
    const { rows } = await c.query(
      `SELECT d.*, n.title AS notification_title, n.priority AS notification_priority,
              u.email AS user_email, u.first_name, u.last_name, u.username,
              COUNT(*) OVER() AS _total
         FROM notification_deliveries d
         LEFT JOIN notifications n ON n.id = d.notification_id
         LEFT JOIN users u ON u.id = d.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );
    const total = rows.length ? Number(rows[0]._total) : 0;
    return {
      rows: toCamelRows(rows.map((r) => stripTotal(r as Record<string, unknown>))),
      pagination: { page, pageSize, total },
    };
  })
);

// ---------------------------------------------------------------------------
// Provider test (Bird)
// ---------------------------------------------------------------------------
communicationOpsRouter.post(
  '/test-send',
  ...run('communication.settings.manage', async (c, ctx, b) => {
    const channel = String(b.channel ?? '').toUpperCase();
    const to = String(b.to ?? '').trim();
    if (!['EMAIL', 'SMS', 'WHATSAPP'].includes(channel)) throw badRequest('channel must be EMAIL, SMS or WHATSAPP');
    if (!to) throw badRequest('to is required (email address or E.164 phone number)');
    const subject = String(b.subject ?? 'HOPE DESIGN ERP test email');
    const body = String(b.body ?? 'This is a test message from the HOPE DESIGN communication center.');
    const provider = String(b.provider ?? 'auto').toLowerCase();
    if (!['auto', 'bird', 'africastalking', 'resend'].includes(provider)) {
      throw badRequest('provider must be auto, bird, africastalking or resend');
    }
    const result =
      channel === 'EMAIL'
        ? await sendEmail({
            to: [to],
            subject,
            text: body,
          }, provider as ProviderOverride)
        : channel === 'SMS'
          ? await sendSms({ to, text: body, category: 'service' }, provider as ProviderOverride)
          : await sendWhatsApp({ to, text: { body } }, provider as ProviderOverride);
    await auditComms(c, ctx, 'PROVIDER_TEST_SENT', 'communication_provider', null, {
      channel, to, provider, ok: result.ok, providerMessageId: result.providerMessageId ?? null, error: result.error ?? null,
    });
    return { channel, to, ...result };
  })
);
// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
communicationOpsRouter.get(
  '/settings',
  ...runGet('communication.settings.manage', async (c, ctx) => {
    if (!ctx.companyId) throw badRequest('Company context is required');
    const { rows } = await c.query(
      `SELECT * FROM communication_settings
        WHERE tenant_id = $1 AND company_id = $2 ORDER BY category, key`,
      [ctx.tenantId ?? 0, ctx.companyId]
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.put(
  '/settings',
  ...run('communication.settings.manage', async (c, ctx, b) => {
    if (!ctx.companyId) throw badRequest('Company context is required');
    const tenantId = ctx.tenantId ?? 0;
    const items = Array.isArray(b.items) ? b.items : [b];
    const saved: Record<string, unknown>[] = [];
    for (const item of items) {
      const category = String(item.category ?? 'GENERAL');
      const key = String(item.key ?? '');
      if (!key) throw badRequest('settings key is required');
      const { rows } = await c.query(
        `INSERT INTO communication_settings (tenant_id, company_id, category, key, value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, company_id, category, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         RETURNING *`,
        [tenantId, ctx.companyId, category, key, JSON.stringify(item.value ?? {})]
      );
      saved.push(toCamelRow(rows[0] as Record<string, unknown>));
    }
    await auditComms(c, ctx, 'SETTINGS_UPDATED', 'communication_settings', null, {
      keys: saved.map((s) => s.key as string),
    });
    return saved;
  })
);
// ---------------------------------------------------------------------------
// Notification rules + personal preferences
// ---------------------------------------------------------------------------
export const NOTIFICATION_EVENT_TYPES = [
  'APPROVAL_REQUIRED', 'APPROVAL_REQUESTED', 'APPROVAL_COMPLETED', 'APPROVAL_REJECTED',
  'APPROVAL_ESCALATED', 'CONTRACT_EXPIRY', 'CONTRACT_SIGNED', 'INVOICE_CREATED',
  'PAYMENT_RECEIVED', 'PAYMENT_DUE', 'PAYMENT_RECEIPT', 'LOW_STOCK', 'STOCK_LOW',
  'STOCK_REORDER', 'LEAVE_APPROVED', 'PAYROLL_PROCESSED', 'SECURITY_EVENT',
  'QUALITY_INSPECTION_PENDING', 'QUALITY_INSPECTION_REQUEST', 'QUALITY_FAILED',
  'QUALITY_REJECTED', 'QUALITY_HOLD', 'MACHINE_DOWN', 'MACHINE_BREAKDOWN',
  'MAINTENANCE_DUE', 'ASSET_MAINTENANCE_DUE', 'ASSET_INSPECTION_DUE',
  'PRODUCTION_DELAYED', 'PRODUCTION_COMPLETED', 'PRODUCTION_ORDER_RELEASED',
  'MATERIAL_SHORTAGE', 'DELIVERY_DISPATCH', 'DELIVERY_DISPATCHED', 'DOCUMENT_UPLOADED',
  'DOCUMENT_EXPIRY', 'INVENTORY_DEAD_STOCK', 'QUARANTINE_AGING', 'WORK_ORDER_STALE',
  'WORK_ORDER_OVERDUE', 'PASSWORD_EXPIRY', 'CUSTODY_OVERDUE', 'SHIFT_SUMMARY',
  'GOODS_RECEIPT', 'CREDIT_NOTE', 'CUSTOMER_RECEIPT',
] as const;

const RULE_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'];


const boolOf = (item: Record<string, unknown>, snake: string, camel: string, dflt: boolean): boolean => {
  const v = item[snake] ?? item[camel];
  return typeof v === 'boolean' ? v : dflt;
};
const parseJsonField = (v: unknown, fallback: unknown): string => {
  if (v === undefined || v === null || v === '') return JSON.stringify(fallback);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

communicationOpsRouter.get(
  '/rules',
  ...runGet('communication.notifications.view', async (c, ctx, q) => {
    const tenantId = ctx.tenantId ?? 0;
    const where = ['nr.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q.event_type) {
      params.push(String(q.event_type));
      where.push(`nr.event_type = $${params.length}`);
    }
    const { rows } = await c.query(
      `SELECT nr.*, u.first_name || ' ' || u.last_name AS created_by_name
         FROM notification_rules nr
         LEFT JOIN users u ON u.id = nr.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY nr.is_active DESC, nr.name ASC`,
      params
    );
    return toCamelRows(rows as Record<string, unknown>[]);
  })
);

communicationOpsRouter.post(
  '/rules',
  ...run('communication.notifications.manage', async (c, ctx, b) => {
    if (!ctx.companyId) throw badRequest('Company context is required');
    const name = String(b.name ?? '').trim();
    const eventType = String(b.event_type ?? '').trim();
    if (!name) throw badRequest('Rule name is required');
    if (!eventType) throw badRequest('Event type is required');
    const channels = Array.isArray(b.channels) && (b.channels as unknown[]).length
      ? (b.channels as unknown[]).map(String).filter((ch) => RULE_CHANNELS.includes(ch))
      : ['IN_APP'];
    const roleCodes = Array.isArray(b.role_codes) ? (b.role_codes as unknown[]).map(String) : [];
    const userIds = Array.isArray(b.user_ids) ? (b.user_ids as unknown[]).map(String) : [];
    const { rows } = await c.query(
      `INSERT INTO notification_rules
         (tenant_id, company_id, name, event_type, conditions, channels, role_codes, user_ids, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
       RETURNING *`,
      [
        ctx.tenantId ?? 0, ctx.companyId, name, eventType,
        parseJsonField(b.conditions, {}),
        JSON.stringify(channels),
        JSON.stringify(roleCodes),
        JSON.stringify(userIds),
        b.is_active === false ? false : true,
        ctx.userId ?? null,
      ]
    );
    const row = toCamelRow(rows[0] as Record<string, unknown>);
    await auditComms(c, ctx, 'NOTIFICATION_RULE_CREATED', 'notification_rule', Number(row.id), {
      name, eventType,
    });
    return row;
  })
);

communicationOpsRouter.patch(
  '/rules/:id',
  ...run('communication.notifications.manage', async (c, ctx, b, p) => {
    const id = Number(p.id);
    if (!Number.isFinite(id)) throw badRequest('Invalid rule id');
    const fields: string[] = [];
    const params: unknown[] = [ctx.tenantId ?? 0, id];
    const set = (col: string, val: unknown, cast = '') => {
      params.push(val);
      fields.push(`${col} = $${params.length}${cast}`);
    };
    if (b.name !== undefined) set('name', String(b.name).trim());
    if (b.event_type !== undefined) set('event_type', String(b.event_type).trim());
    if (b.conditions !== undefined) set('conditions', parseJsonField(b.conditions, {}), '::jsonb');
    if (b.channels !== undefined) {
      const channels = Array.isArray(b.channels) ? (b.channels as unknown[]).map(String).filter((ch) => RULE_CHANNELS.includes(ch)) : ['IN_APP'];
      set('channels', JSON.stringify(channels), '::jsonb');
    }
    if (b.role_codes !== undefined) {
      const roleCodes = Array.isArray(b.role_codes) ? (b.role_codes as unknown[]).map(String) : [];
      set('role_codes', JSON.stringify(roleCodes), '::jsonb');
    }
    if (b.user_ids !== undefined) {
      const userIds = Array.isArray(b.user_ids) ? (b.user_ids as unknown[]).map(String) : [];
      set('user_ids', JSON.stringify(userIds), '::jsonb');
    }
    if (b.is_active !== undefined) set('is_active', b.is_active === false ? false : true);
    if (fields.length === 0) throw badRequest('Nothing to update');
    const { rows } = await c.query(
      `UPDATE notification_rules SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      params
    );
    if (!rows.length) throw notFound('Notification rule not found');
    const row = toCamelRow(rows[0] as Record<string, unknown>);
    await auditComms(c, ctx, 'NOTIFICATION_RULE_UPDATED', 'notification_rule', id, {
      name: row.name, eventType: row.eventType,
    });
    return row;
  })
);

communicationOpsRouter.get(
  '/preferences',
  ...runGet('communication.notifications.view', async (c, ctx) => {
    const tenantId = ctx.tenantId ?? 0;
    const uid = ctx.userId ?? 0;
    const { rows } = await c.query(
      `SELECT * FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, uid]
    );
    const stored = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const key = String(r.event_type);
      stored.set(key, toCamelRow(r as Record<string, unknown>));
    }
    const merged = NOTIFICATION_EVENT_TYPES.map((et) => {
      const existing = stored.get(et);
      return {
        eventType: et,
        inApp: existing ? existing.inApp : true,
        email: existing ? existing.email : true,
        push: existing ? existing.push : true,
        sms: existing ? existing.sms : false,
        whatsapp: existing ? existing.whatsapp : false,
        digest: existing ? existing.digest : 'INSTANT',
        criticalBypass: existing ? existing.criticalBypass : true,
      };
    });
    return { rows: merged, eventTypes: NOTIFICATION_EVENT_TYPES };
  })
);

communicationOpsRouter.put(
  '/preferences',
  ...run('communication.notifications.read', async (c, ctx, b) => {
    const tenantId = ctx.tenantId ?? 0;
    const uid = ctx.userId ?? 0;
    if (!uid) throw badRequest('Authenticated user is required');
    const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
    if (!items.length) throw badRequest('At least one preference item is required');
    const saved: Record<string, unknown>[] = [];
    for (const item of items) {
      const eventType = String(item.event_type ?? '').trim();
      if (!eventType) throw badRequest('event_type is required for each preference');
      const { rows } = await c.query(
        `INSERT INTO notification_preferences
           (tenant_id, user_id, event_type, in_app, email, push, sms, whatsapp, digest, critical_bypass)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, user_id, event_type)
         DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email,
           push = EXCLUDED.push, sms = EXCLUDED.sms, whatsapp = EXCLUDED.whatsapp,
           digest = EXCLUDED.digest, critical_bypass = EXCLUDED.critical_bypass,
           updated_at = now()
         RETURNING *`,
        [
          tenantId, uid, eventType,
          boolOf(item, 'in_app', 'inApp', true),
          boolOf(item, 'email', 'email', true),
          boolOf(item, 'push', 'push', true),
          boolOf(item, 'sms', 'sms', false),
          boolOf(item, 'whatsapp', 'whatsapp', false),
          String(item.digest ?? 'INSTANT').toUpperCase(),
          boolOf(item, 'critical_bypass', 'criticalBypass', true),
        ]
      );
      saved.push(toCamelRow(rows[0] as Record<string, unknown>));
    }
    await auditComms(c, ctx, 'NOTIFICATION_PREFERENCES_UPDATED', 'notification_preference', null, {
      count: saved.length,
    });
    return { saved: saved.length };
  })
);
