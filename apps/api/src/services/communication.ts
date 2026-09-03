import pg from 'pg';
import { Ctx, query } from '../db.js';
import { dispatchBird } from './bird.js';
import { config } from '../config.js';
import { normalizeE164 } from './africastalking.js';

export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL';
export type NotificationSeverity = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export interface NotifyInput {
  userIds?: number[];
  roleCodes?: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: number;
  priority?: NotificationPriority;
  severity?: NotificationSeverity;
  actionLabel?: string;
  actionTarget?: string;
  data?: Record<string, unknown>;
  channels?: string[];
  actionRequired?: boolean;
}

/** Resolve recipient user ids from explicit ids and/or role codes within the tenant. */
export async function resolveRecipients(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Pick<NotifyInput, 'userIds' | 'roleCodes'>
): Promise<number[]> {
  const tenantId = ctx.tenantId ?? 0;
  const ids = new Set<number>((input.userIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const roleCodes = (input.roleCodes ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  if (roleCodes.length > 0) {
    const { rows } = await client.query(
      `SELECT DISTINCT ur.user_id AS id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE r.tenant_id = $1 AND r.code = ANY($2::text[])
          AND (ur.company_id IS NULL OR ur.company_id = $3)`,
      [tenantId, roleCodes, ctx.companyId ?? null]
    );
    for (const row of rows) ids.add(Number(row.id));
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Channel resolution: personal preferences + tenant notification rules
// ---------------------------------------------------------------------------

interface UserChannelPrefs {
  inApp: boolean;
  email: boolean;
  push: boolean;
  sms: boolean;
  whatsapp: boolean;
  digest: string;
  criticalBypass: boolean;
}

const DEFAULT_CHANNEL_PREFS: UserChannelPrefs = {
  inApp: true,
  email: true,
  push: true,
  sms: true,
  whatsapp: false,
  digest: 'INSTANT',
  criticalBypass: true,
};

const DIGEST_RANK: Record<string, number> = { INSTANT: 0, '15_MIN': 1, HOURLY: 2, DAILY: 3, WEEKLY: 4 };

/**
 * Map a notification `type` to the notification-rule event types it belongs
 * to. Rules use uppercase event types (e.g. STOCK_LOW) while internal services
 * pass dotted types (e.g. inventory.low_stock), so known aliases are resolved.
 */
function ruleEventTypes(type: string): string[] {
  const upper = (type ?? '').trim().toUpperCase();
  if (!upper) return [];
  const norm = upper.replace(/[^A-Z0-9]/g, '');
  if (!norm) return [];
  const alias: Record<string, string[]> = {
    INVENTORYLOWSTOCK: ['STOCK_LOW', 'STOCK_REORDER'],
    HRCONTRACTEXPIRY: ['CONTRACT_EXPIRY'],
    ASSETMAINTENANCEDUE: ['MAINTENANCE_DUE'],
    PRODUCTIONWORKORDEROVERDUE: ['WORK_ORDER_OVERDUE'],
    PRODUCTIONWORKORDERSTALE: ['WORK_ORDER_OVERDUE'],
    APPROVALESCALATED: ['APPROVAL_REQUIRED', 'APPROVAL_ESCALATED'],
    APPROVALREQUEST: ['APPROVAL_REQUIRED'],
    APPROVALREQUESTED: ['APPROVAL_REQUIRED'],
  };
  return alias[norm] ?? [upper];
}

function mergePrefs(rows: Record<string, unknown>[]): UserChannelPrefs {
  if (rows.length === 0) return { ...DEFAULT_CHANNEL_PREFS };
  const prefs: UserChannelPrefs = { ...DEFAULT_CHANNEL_PREFS };
  let digest = 'WEEKLY';
  let bestRank = DIGEST_RANK[digest] ?? 4;
  for (const r of rows) {
    prefs.inApp = r.in_app !== false;
    prefs.email = r.email !== false;
    prefs.push = r.push !== false;
    prefs.sms = r.sms !== false;
    prefs.whatsapp = r.whatsapp === true;
    prefs.criticalBypass = r.critical_bypass !== false;
    const d = String(r.digest ?? 'INSTANT');
    const rank = DIGEST_RANK[d] ?? 0;
    if (rank < bestRank) {
      bestRank = rank;
      digest = d;
    }
  }
  prefs.digest = digest;
  return prefs;
}

async function getUserPrefs(
  client: pg.PoolClient,
  tenantId: number,
  userId: number,
  eventTypes: string[]
): Promise<UserChannelPrefs> {
  if (eventTypes.length === 0) return { ...DEFAULT_CHANNEL_PREFS };
  const { rows } = await client.query(
    `SELECT event_type, in_app, email, push, sms, whatsapp, digest, critical_bypass
       FROM notification_preferences
      WHERE tenant_id = $1 AND user_id = $2
        AND (event_type = ANY($3::text[])
             OR regexp_replace(event_type, '[^A-Z0-9]', '', 'g') = $4)
      ORDER BY event_type ASC`,
    [tenantId, userId, eventTypes, (eventTypes[0] ?? '').replace(/[^A-Z0-9]/g, '')]
  );
  return mergePrefs(rows as Record<string, unknown>[]);
}

interface RuleMatch {
  channels: string[];
  userIds: number[];
  roleCodes: string[];
}

/** Union of active notification rules matching the event type. */
async function getRulesForEvent(client: pg.PoolClient, ctx: Ctx, eventTypes: string[]): Promise<RuleMatch> {
  const tenantId = ctx.tenantId ?? 0;
  const companyId = ctx.companyId ?? null;
  const empty: RuleMatch = { channels: [], userIds: [], roleCodes: [] };
  if (eventTypes.length === 0) return empty;
  const { rows } = await client.query(
    `SELECT channels, user_ids, role_codes
       FROM notification_rules
      WHERE tenant_id = $1 AND is_active = true
        AND (company_id IS NULL OR company_id = $3)
        AND (event_type = ANY($2::text[])
             OR regexp_replace(event_type, '[^A-Z0-9]', '', 'g') = $4)`,
    [tenantId, eventTypes, companyId, (eventTypes[0] ?? '').replace(/[^A-Z0-9]/g, '')]
  );
  const channels = new Set<string>();
  const userIds = new Set<number>();
  const roleCodes = new Set<string>();
  for (const r of rows as Record<string, unknown>[]) {
    if (Array.isArray(r.channels)) {
      for (const ch of r.channels) if (typeof ch === 'string' && ch.trim()) channels.add(ch.trim().toUpperCase());
    }
    if (Array.isArray(r.user_ids)) {
      for (const u of r.user_ids) {
        const n = Number(u);
        if (Number.isFinite(n) && n > 0) userIds.add(n);
      }
    }
    if (Array.isArray(r.role_codes)) {
      for (const rc of r.role_codes) if (typeof rc === 'string' && rc.trim()) roleCodes.add(rc.trim());
    }
  }
  return { channels: [...channels], userIds: [...userIds], roleCodes: [...roleCodes] };
}

function filterChannelsByPrefs(channels: string[], prefs: UserChannelPrefs): string[] {
  return channels.filter((ch) => {
    switch (ch) {
      case 'IN_APP': return prefs.inApp;
      case 'EMAIL': return prefs.email;
      case 'PUSH': return prefs.push;
      case 'SMS': return prefs.sms;
      case 'WHATSAPP': return prefs.whatsapp;
      default: return false;
    }
  });
}

/** Create notifications (and per-channel deliveries) for a set of users. */
export async function notifyUsers(
  client: pg.PoolClient,
  ctx: Ctx,
  input: NotifyInput,
  userIds: number[]
): Promise<number[]> {
  const tenantId = ctx.tenantId ?? 0;
  const companyId = ctx.companyId ?? null;
  const eventTypes = ruleEventTypes(input.type);
  const rule = await getRulesForEvent(client, ctx, eventTypes);
  const ruleRecipients = await resolveRecipients(client, ctx, {
    userIds: rule.userIds,
    roleCodes: [...(rule.roleCodes ?? []), ...(input.roleCodes ?? [])],
  });
  const recipients = new Set<number>(userIds.map(Number).filter((n) => Number.isFinite(n) && n > 0));
  for (const id of ruleRecipients) recipients.add(id);

  const explicitChannels = (input.channels ?? [])
    .map((ch) => String(ch).trim().toUpperCase())
    .filter((ch) => ch.length > 0);
  const created: number[] = [];

  for (const uid of recipients) {
    const prefs = await getUserPrefs(client, tenantId, uid, eventTypes);
    let channels = explicitChannels.length > 0 ? [...explicitChannels] : [...rule.channels];
    if (channels.length === 0) channels = ['IN_APP', 'EMAIL'];
    channels = [...new Set(filterChannelsByPrefs(channels, prefs))];
    // The in-app copy is always created when the user has not disabled it.
    if (!channels.includes('IN_APP') && prefs.inApp) channels.unshift('IN_APP');
    // Digest: non-instant digests surface in-app immediately and defer external
    // channels to the digest run (a future digest job emits the bundled copy).
    const critical = input.priority === 'CRITICAL';
    if (prefs.digest !== 'INSTANT' && !(critical && prefs.criticalBypass)) {
      channels = channels.filter((ch) => ch === 'IN_APP');
    }
    if (channels.length === 0) continue;

    const { rows } = await client.query(
      `INSERT INTO notifications
         (company_id, tenant_id, user_id, type, title, body, link, entity_type, entity_id,
          severity, action_required, priority, channel, action_label, action_target, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        companyId,
        tenantId,
        uid,
        input.type,
        input.title,
        input.body ?? null,
        input.link ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.severity ?? 'INFO',
        input.actionLabel != null || input.actionRequired === true,
        input.priority ?? 'NORMAL',
        channels[0],
        input.actionLabel ?? null,
        input.actionTarget ?? null,
        JSON.stringify(input.data ?? {}),
      ]
    );
    const notificationId = Number(rows[0].id);
    created.push(notificationId);
    for (const ch of channels) {
      await client.query(
        `INSERT INTO notification_deliveries
           (tenant_id, notification_id, user_id, channel, recipient, status, provider, sent_at)
         VALUES ($1,$2,$3,$4,
                 CASE WHEN $4 IN ('SMS','WHATSAPP') THEN (SELECT phone FROM users WHERE id = $3)
                      ELSE (SELECT email FROM users WHERE id = $3) END,
                 CASE WHEN $4 IN ('IN_APP','PUSH') THEN 'DELIVERED' ELSE 'QUEUED' END,
                 $5, now())
         ON CONFLICT DO NOTHING`,
        [tenantId, notificationId, uid, ch, ch.toLowerCase()]
      );
    }
  }
  return created;
}

/** Advanced-pipeline wrapper matching the legacy `notifyRole` shape. */
export async function notifyRoleAdvanced(
  client: pg.PoolClient,
  ctx: Ctx,
  roleCodes: string[],
  n: Omit<NotifyInput, 'userIds' | 'roleCodes'> & { actionRequired?: boolean }
): Promise<number[]> {
  return notifyUsers(client, ctx, { ...n, roleCodes }, []);
}

/** Advanced-pipeline wrapper matching the legacy `createNotification` shape. */
export async function notifyUserAdvanced(
  client: pg.PoolClient,
  ctx: Ctx,
  userId: number,
  n: Omit<NotifyInput, 'userIds' | 'roleCodes'> & { actionRequired?: boolean }
): Promise<number[]> {
  return notifyUsers(client, ctx, { ...n }, [Number(userId)]);
}

/** Append an event to the communication event stream. */
export async function recordEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  eventType: string,
  payload: Record<string, unknown>,
  entityType?: string,
  entityId?: number
): Promise<void> {
  await client.query(
    `INSERT INTO communication_events (tenant_id, company_id, entity_type, entity_id, actor_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      ctx.tenantId ?? 0,
      ctx.companyId ?? null,
      entityType ?? null,
      entityId ?? null,
      ctx.userId ?? null,
      eventType,
      JSON.stringify(payload),
    ]
  );
}

/** Audit a communication action (comms-specific audit trail). */
export async function auditComms(
  client: pg.PoolClient,
  ctx: Ctx,
  action: string,
  targetType: string,
  targetId: number | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO communication_audit_logs
       (tenant_id, company_id, user_id, action, target_type, target_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ctx.tenantId ?? 0,
      ctx.companyId ?? null,
      ctx.userId ?? null,
      action,
      targetType,
      targetId,
      JSON.stringify(detail),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
    ]
  );
}

/** Render {{VAR}} placeholders in a template subject/body. */
export function renderTemplate(
  subject: string,
  body: string,
  variables: Record<string, unknown>
): { subject: string; body: string } {
  const fill = (s: string): string =>
    s.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string) => {
      const v = variables[key];
      return v == null ? `{{${key}}}` : String(v);
    });
  return { subject: fill(subject), body: fill(body) };
}

/** Format a date-ish value as YYYY-MM-DD for template variables. */
function fmtTemplateDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Render an email row's subject/body with template variables before sending.
 * Variable sources, in priority order:
 *   1. template_vars stored on the email (from the composer / callers)
 *   2. vars auto-resolved from the linked entity (entity_type + entity_id)
 *   3. global defaults (COMPANY_NAME from the company row)
 * Unresolved {{VAR}} tokens are left in place so senders can spot gaps.
 */
export async function renderEmailForSend(
  client: pg.PoolClient,
  email: Record<string, unknown>
): Promise<{ subject: string; body: string }> {
  const vars: Record<string, unknown> = {};
  const stored = email.template_vars;
  if (stored && typeof stored === 'object') {
    Object.assign(vars, stored as Record<string, unknown>);
  }
  const entityType = String(email.entity_type ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const entityId = Number(email.entity_id ?? 0);
  if (Number.isFinite(entityId) && entityId > 0) {
    const setName = (name: string) => {
      if (name) {
        vars.EMPLOYEE_NAME = name;
        vars.RECIPIENT_NAME = name;
      }
    };
    if (entityType.includes('employee')) {
      const { rows } = await client.query(
        `SELECT first_name, last_name FROM employees WHERE id = $1 AND tenant_id = $2 AND (company_id = $3 OR $3 IS NULL)`,
        [entityId, email.tenant_id, email.company_id]
      );
      if (rows[0]) setName([rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ').trim());
    } else if (entityType.includes('leave')) {
      const { rows } = await client.query(
        `SELECT l.leave_type, l.start_date::text AS start_date, l.end_date::text AS end_date,
               l.days, e.first_name, e.last_name
           FROM leave_requests l
           JOIN employees e ON e.id = l.employee_id
          WHERE l.id = $1
            AND e.tenant_id = $2 AND (e.company_id = $3 OR $3 IS NULL)`,
        [entityId, email.tenant_id, email.company_id]
      );
      if (rows[0]) {
        const r = rows[0];
        setName([r.first_name, r.last_name].filter(Boolean).join(' ').trim());
        if (r.leave_type != null) vars.LEAVE_TYPE = String(r.leave_type);
        if (r.start_date != null) vars.START_DATE = fmtTemplateDate(r.start_date);
        if (r.end_date != null) vars.END_DATE = fmtTemplateDate(r.end_date);
        if (r.days != null) vars.DAYS = String(Number(r.days));
      }
    } else if (entityType.includes('customer')) {
      const { rows } = await client.query(
        `SELECT name FROM customers WHERE id = $1 AND tenant_id = $2 AND (company_id = $3 OR $3 IS NULL)`,
        [entityId, email.tenant_id, email.company_id]
      );
      if (rows[0]?.name) {
        vars.CUSTOMER_NAME = String(rows[0].name);
        vars.RECIPIENT_NAME = String(rows[0].name);
      }
    } else if (entityType.includes('supplier')) {
      const { rows } = await client.query(
        `SELECT name FROM suppliers WHERE id = $1 AND tenant_id = $2 AND (company_id = $3 OR $3 IS NULL)`,
        [entityId, email.tenant_id, email.company_id]
      );
      if (rows[0]?.name) {
        vars.SUPPLIER_NAME = String(rows[0].name);
        vars.RECIPIENT_NAME = String(rows[0].name);
      }
    }
  }
  if (vars.COMPANY_NAME == null) {
    const companyId = Number(email.company_id ?? 0);
    if (Number.isFinite(companyId) && companyId > 0) {
      const { rows } = await client.query(
        `SELECT name, legal_name FROM companies WHERE id = $1 AND tenant_id = $2`,
        [companyId, email.tenant_id]
      );
      if (rows[0]) vars.COMPANY_NAME = String(rows[0].legal_name || rows[0].name || '').trim();
    }
    if (!vars.COMPANY_NAME) vars.COMPANY_NAME = 'HOPE DESIGN GROUP LTD';
  }
  return renderTemplate(
    String(email.subject ?? 'HOPE DESIGN ERP'),
    String(email.body ?? ''),
    vars
  );
}
// ---------------------------------------------------------------------------
// Delivery dispatcher (Bird email / SMS / WhatsApp)
// ---------------------------------------------------------------------------

const RETRY_DELAYS_SECONDS = [30, 120, 600];
const MAX_DELIVERY_RETRIES = 3;

let deliveryLoopRunning = false;

/**
 * Dispatch queued EMAIL/SMS/WHATSAPP deliveries through the Bird provider.
 * Called on an interval from the API server (single-flight). On failure the
 * delivery is retried with an exponential backoff, then marked FAILED.
 */
export async function processNotificationDeliveries(): Promise<{ processed: number; ok: number; failed: number }> {
  if (deliveryLoopRunning) return { processed: 0, ok: 0, failed: 0 };
  deliveryLoopRunning = true;
  try {
    const res = await query(
      `SELECT d.id, d.tenant_id, d.user_id, d.channel, d.recipient, d.retry_count,
              n.title, n.body, n.action_label, n.action_target, u.email, u.phone
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
         JOIN users u ON u.id = d.user_id
        WHERE d.channel IN ('EMAIL','SMS','WHATSAPP')
          AND d.status IN ('QUEUED','RETRYING')
          AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
        ORDER BY d.created_at ASC
        LIMIT 100`
    );
    let ok = 0;
    let failed = 0;
    for (const row of res.rows as Record<string, unknown>[]) {
      const deliveryId = Number(row.id);
      const channel = String(row.channel);
      const recipient = String(row.recipient ?? '').trim();
      const email = String(row.email ?? '').trim();
      const phone = String(row.phone ?? '').trim();
      const rawTo = channel === 'EMAIL' ? recipient || email : recipient || phone;
      const to = channel === 'EMAIL' ? rawTo : normalizeE164(rawTo);
      const body = String(row.body ?? '');
      const actionLabel = String(row.action_label ?? '').trim();
      const actionTarget = String(row.action_target ?? '').trim();
      const button =
        channel === 'EMAIL' && actionLabel && actionTarget
          ? { label: actionLabel, url: `${config.webPublicUrl}${actionTarget.startsWith('/') ? '' : '/'}${actionTarget}` }
          : undefined;
      const result = !to
        ? { ok: false as const, error: 'No recipient for ' + channel + ' delivery' }
        : await dispatchBird(channel, to, {
            title: String(row.title ?? ''),
            body,
            button,
          });
      const terminal =
        !to ||
        /quota|rate limit|not configured|missing|invalid|no recipient/i.test(result.error ?? '');
      if (result.ok) {
        await query(
          `UPDATE notification_deliveries
              SET status = 'SENT', provider = $1, provider_message_id = $2, sent_at = now(), error = NULL
            WHERE id = $3`,
          [result.provider ?? 'bird', result.providerMessageId ?? null, deliveryId]
        );
        if (channel === 'SMS') {
          await query(
            `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, provider_message_id, sent_at)
             VALUES ($1,$2,$3,$4,$5,'SENT',$6,now())`,
            [row.tenant_id, row.user_id, to, body, result.provider ?? 'bird', result.providerMessageId ?? null]
          );
        }
        ok += 1;
      } else {
        const attempts = Number(row.retry_count ?? 0) + 1;
        if (!terminal && attempts <= MAX_DELIVERY_RETRIES) {
          const delaySeconds =
            RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
          await query(
            `UPDATE notification_deliveries
                SET status = 'RETRYING', retry_count = $1, error = $2,
                    next_retry_at = now() + ($3::int || ' seconds')::interval
              WHERE id = $4`,
            [attempts, result.error ?? 'unknown', delaySeconds, deliveryId]
          );
          if (channel === 'SMS') {
            await query(
              `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, error, retry_count)
               VALUES ($1,$2,$3,$4,$5,'RETRYING',$6,$7)`,
              [row.tenant_id, row.user_id, to, body, result.provider ?? 'bird', result.error ?? 'unknown', attempts]
            );
          }
        } else {
          await query(
            `UPDATE notification_deliveries
                SET status = 'FAILED', retry_count = $1, error = $2
              WHERE id = $3`,
            [attempts, result.error ?? 'unknown', deliveryId]
          );
          if (channel === 'SMS') {
            await query(
              `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, error, retry_count)
               VALUES ($1,$2,$3,$4,$5,'FAILED',$6,$7)`,
              [row.tenant_id, row.user_id, to, body, result.provider ?? 'bird', result.error ?? 'unknown', attempts]
            );
          }
        }
        failed += 1;
      }
    }
    return { processed: res.rows.length, ok, failed };
  } finally {
    deliveryLoopRunning = false;
  }
}

export interface CustomerNotifyInput {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: number | null;
  channels?: Array<'EMAIL' | 'SMS'>;
  button?: { label: string; url: string } | null;
}

/** Send EMAIL/SMS to an external customer (not an ERP user) and record the traffic. */
export async function notifyCustomer(
  client: pg.PoolClient,
  ctx: Ctx,
  input: CustomerNotifyInput
): Promise<{ email?: { ok: boolean; error?: string }; sms?: { ok: boolean; error?: string } }> {
  const channels = input.channels?.length ? input.channels : ['EMAIL', 'SMS'];
  const emailAddr = String(input.email ?? '').trim();
  const phone = normalizeE164(String(input.phone ?? '').trim());
  const out: { email?: { ok: boolean; error?: string }; sms?: { ok: boolean; error?: string } } = {};
  const tenantId = ctx.tenantId ?? 0;

  if (channels.includes('EMAIL')) {
    if (!emailAddr) {
      out.email = { ok: false, error: 'Customer has no email address' };
    } else {
      const result = await dispatchBird('EMAIL', emailAddr, {
        title: input.title,
        body: input.body,
        button: input.button ?? undefined,
      });
      out.email = { ok: result.ok, error: result.error };
      const { rows } = await client.query(
        `INSERT INTO emails
           (tenant_id, company_id, branch_id, direction, subject, body, "to", status, sent_at,
            entity_type, entity_id, created_by)
         VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          tenantId,
          ctx.companyId ?? null,
          ctx.branchId ?? null,
          input.title,
          input.body,
          JSON.stringify([emailAddr]),
          result.ok ? 'SENT' : 'FAILED',
          result.ok ? new Date() : null,
          input.entityType ?? null,
          input.entityId ?? null,
          ctx.userId ?? null,
        ]
      );
      const emailId = Number(rows[0]?.id);
      if (emailId) {
        await client.query(
          `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status, provider_message_id, error, sent_at)
           VALUES ($1,$2,'TO',$3,$4,$5,$6,$7)`,
          [
            tenantId,
            emailId,
            emailAddr,
            result.ok ? 'SENT' : 'FAILED',
            result.providerMessageId ?? null,
            result.error ?? null,
            result.ok ? new Date() : null,
          ]
        );
      }
    }
  }

  if (channels.includes('SMS')) {
    if (!phone) {
      out.sms = { ok: false, error: 'Customer has no phone number' };
    } else {
      const smsBody = `${input.title}. ${input.body}`.replace(/\s+/g, ' ').slice(0, 480);
      const result = await dispatchBird('SMS', phone, { title: input.title, body: smsBody });
      out.sms = { ok: result.ok, error: result.error };
      await client.query(
        `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, provider_message_id, error, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId,
          ctx.userId ?? null,
          phone,
          smsBody,
          result.provider ?? null,
          result.ok ? 'SENT' : 'FAILED',
          result.providerMessageId ?? null,
          result.error ?? null,
          result.ok ? new Date() : null,
        ]
      );
    }
  }
  return out;
}
