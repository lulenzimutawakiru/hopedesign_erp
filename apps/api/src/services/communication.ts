import pg from 'pg';
import { Ctx, query } from '../db.js';
import { dispatchBird, type EmailAttachmentInput } from './bird.js';
import { config } from '../config.js';
import { normalizeE164 } from './africastalking.js';
import { renderButton } from './emailBranding.js';

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

// ---------------------------------------------------------------------------
// System-generated outbound mail
// ---------------------------------------------------------------------------

/**
 * Permissions a system-generated message is sent under.
 *
 * `sendStoredEmail` evaluates mailbox authorisation with the same `permissions`
 * value it then uses for the ERP document attachment, so a notification helper
 * cannot simply act as its caller: the person who triggered the notification
 * normally holds no grant on the system mailbox the message must leave from.
 * Mail-administration rights are what the tenant's own mailboxes are governed
 * by, and are exactly what a system notification acts under.
 */
export const MAIL_SYSTEM_PERMISSIONS: readonly string[] = ['communication.mail_admin.manage'];

export interface InsertOutboundEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Rich-text body; the pipeline applies the mailbox signature on top. */
  html?: string | null;
  /** Business record this message belongs to - drives vars and the PDF attach. */
  entityType?: string | null;
  entityId?: number | null;
  /** Send from this mailbox. Defaults to the tenant's notification mailbox. */
  mailboxId?: number | null;
  /** Author of record, for the audit trail and the signature. */
  createdBy?: number | null;
  /**
   * Permissions the document attachment runs under. Defaults to
   * MAIL_SYSTEM_PERMISSIONS; pass the author's rights to keep an attached
   * document subject to what they are allowed to read.
   */
  authorPermissions?: readonly string[];
  /** 'PUBLIC' for customer-facing mail, 'INTERNAL' for staff mail. */
  classification?: string;
  /** The pipeline sends immediately unless the stored row is scheduled. */
  forceNow?: boolean;
  /**
   * Attachments supplied inline by the caller, as base64 bytes. The scheduled
   * reports render their own PDF and have no `entity` for the document-
   * attachment path to pick up, so they hand the file over directly.
   */
  attachments?: EmailAttachmentInput[];
}

export interface InsertOutboundEmailResult {
  emailId: number | null;
  outcome: 'SENT' | 'FAILED' | 'SCHEDULED' | 'PENDING_APPROVAL';
  error?: string | null;
  providerMessageId?: string | null;
}

/** Pick the mailbox a system-generated message leaves from. */
async function resolveSystemMailboxId(
  client: pg.PoolClient,
  tenantId: number,
  requested?: number | null
): Promise<number | null> {
  if (requested) return Number(requested);
  const preferred = await client.query(
    `SELECT id FROM mailboxes
      WHERE tenant_id = $1 AND is_active = true AND kind = 'SYSTEM'
        AND code = ANY($2::text[])
      ORDER BY array_position($2::text[], code)
      LIMIT 1`,
    [tenantId, ['MAIL-NOTIFICATIONS', 'MAIL-NOREPLY']]
  );
  if (preferred.rows[0]) return Number(preferred.rows[0].id);
  const anySystem = await client.query(
    `SELECT id FROM mailboxes
      WHERE tenant_id = $1 AND is_active = true AND kind = 'SYSTEM'
      ORDER BY id
      LIMIT 1`,
    [tenantId]
  );
  return anySystem.rows[0] ? Number(anySystem.rows[0].id) : null;
}

/**
 * Store a system-generated message and push it through the one outbound
 * pipeline, so a notification receives what a hand-composed message receives:
 * the mailbox signature, the classification policy, template rendering and the
 * ERP document for the linked record.
 *
 * This never throws. A notification failing must not fail the leave approval or
 * order status change that triggered it, so every error becomes a FAILED
 * result and a parked OUTBOX row an operator can see and retry.
 */
export async function insertOutboundEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: InsertOutboundEmailOptions
): Promise<InsertOutboundEmailResult> {
  const tenantId = ctx.tenantId ?? 0;
  const norm = (list: string[] | undefined): string[] =>
    (list ?? []).map((a) => String(a ?? '').trim()).filter((a) => a.length > 0);
  const to = norm(opts.to);
  const cc = norm(opts.cc);
  const bcc = norm(opts.bcc);
  if (to.length === 0) {
    return { emailId: null, outcome: 'FAILED', error: 'No recipients' };
  }

  const mailboxId = await resolveSystemMailboxId(client, tenantId, opts.mailboxId);
  if (!mailboxId) {
    return { emailId: null, outcome: 'FAILED', error: 'No system mailbox is configured for this tenant.' };
  }

  const createdBy = opts.createdBy ?? ctx.userId ?? null;

  // The author's own rights decide what may be attached. Assuming the mail-admin
  // grant here silently skipped every document for notification mail, because
  // mail-admin is a mailbox permission and not a document permission.
  let authorPermissions: readonly string[] = opts.authorPermissions ?? MAIL_SYSTEM_PERMISSIONS;
  let companyId = ctx.companyId ?? null;
  let branchId = ctx.branchId ?? null;
  if (!opts.authorPermissions && createdBy) {
    try {
      const { loadAuthUser } = await import('../middleware/auth.js');
      const author = await loadAuthUser(Number(createdBy), tenantId);
      authorPermissions = author.permissions;
      companyId = author.company_id ?? companyId;
      branchId = author.branch_id ?? branchId;
    } catch {
      // An author that cannot be loaded keeps the system grant. The message
      // still sends; it simply travels without an auto-attached document.
    }
  }

  // Store first: the pipeline loads a message back out of `emails`, and a
  // stored row is what makes a failed send visible and retryable.
  const inserted = await client.query(
    `INSERT INTO emails
       (tenant_id, company_id, branch_id, direction, subject, body, "to", cc, bcc,
        status, folder, mailbox_id, entity_type, entity_id, created_by,
        classification, approval_state)
     VALUES ($1,$2,$3,'OUT',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,
             'QUEUED','OUTBOX',$9,$10,$11,$12,$13,'NOT_REQUIRED')
     RETURNING id`,
    [
      tenantId,
      companyId,
      branchId,
      opts.subject,
      String(opts.body ?? ''),
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(bcc),
      mailboxId,
      opts.entityType ?? null,
      opts.entityId ?? null,
      createdBy,
      opts.classification ?? 'INTERNAL',
    ]
  );
  const emailId = Number(inserted.rows[0]?.id ?? 0);
  if (!emailId) {
    return { emailId: null, outcome: 'FAILED', error: 'Could not store the message' };
  }

  const recipients: Array<[string, string]> = [
    ...to.map((e): [string, string] => ['TO', e]),
    ...cc.map((e): [string, string] => ['CC', e]),
    ...bcc.map((e): [string, string] => ['BCC', e]),
  ];
  for (const [kind, email] of recipients) {
    await client.query(
      `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status)
       VALUES ($1,$2,$3,$4,'QUEUED')`,
      [tenantId, emailId, kind, email]
    );
  }

  // Imported lazily: send.ts imports back into this module, so a static import
  // would close that cycle at module-load time.
  const { sendStoredEmail } = await import('./mail/send.js');
  const systemCtx: Ctx = { ...ctx, userId: createdBy };

  try {
    // Attach first, so the author's own rights govern the document they asked
    // for. The call inside sendStoredEmail is a no-op once it is attached.
    if (opts.entityType && Number(opts.entityId ?? 0) > 0) {
      const { attachErpDocumentForEmail } = await import('./mail/erpAttachment.js');
      const stored = await client.query(
        `SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`,
        [emailId, tenantId]
      );
      if (stored.rows[0]) {
        await attachErpDocumentForEmail(
          client,
          ctx,
          authorPermissions,
          stored.rows[0] as Record<string, unknown>
        );
      }
    }

    const result = await sendStoredEmail(client, systemCtx, MAIL_SYSTEM_PERMISSIONS, emailId, {
      forceNow: opts.forceNow !== false,
      mailboxId,
      html: opts.html ?? null,
      attachments: opts.attachments,
    });
    return {
      emailId,
      outcome: result.outcome,
      error: result.error,
      providerMessageId: result.providerMessageId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Could not be sent';
    // A policy or permission throw parks the message rather than losing it; a
    // delivery failure was already parked inside sendStoredEmail.
    try {
      await client.query(
        `UPDATE emails SET status = 'FAILED', folder = 'OUTBOX', updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [emailId, tenantId]
      );
      await client.query(
        `UPDATE email_recipients SET status = 'FAILED', error = $2, updated_at = now()
          WHERE email_id = $1 AND status = 'QUEUED'`,
        [emailId, reason]
      );
      await client.query(
        `INSERT INTO email_outbox (tenant_id, email_id, status, attempts, last_error)
         VALUES ($1,$2,'QUEUED',1,$3)
         ON CONFLICT (email_id) DO UPDATE
           SET status = 'QUEUED',
               last_error = EXCLUDED.last_error,
               updated_at = now()`,
        [tenantId, emailId, reason]
      );
      await auditComms(client, ctx, 'EMAIL_SEND_FAILED', 'email', emailId, { error: reason });
    } catch {
      // Nothing more can be done here; the message is still stored and retryable.
    }
    return { emailId, outcome: 'FAILED', error: reason };
  }
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
      const { rows: deliveryRows } = await client.query(
        `INSERT INTO notification_deliveries
           (tenant_id, notification_id, user_id, channel, recipient, status, provider, sent_at)
         VALUES ($1,$2,$3,$4,
                 CASE WHEN $4 IN ('SMS','WHATSAPP') THEN (SELECT phone FROM users WHERE id = $3)
                      ELSE (SELECT email FROM users WHERE id = $3) END,
                 CASE WHEN $4 IN ('IN_APP','PUSH') THEN 'DELIVERED' ELSE 'QUEUED' END,
                 $5, now())
         ON CONFLICT DO NOTHING
         RETURNING id, recipient`,
        [tenantId, notificationId, uid, ch, ch.toLowerCase()]
      );
      // The EMAIL copy leaves through the same pipeline as hand-composed mail,
      // so it carries the mailbox signature and the ERP document of the record
      // it is about. The delivery row is closed out with the outcome: left
      // QUEUED, the delivery worker would pick it up and send a second copy.
      const delivery = deliveryRows[0];
      if (ch === 'EMAIL' && delivery) {
        const recipient = String(delivery.recipient ?? '').trim();
        const sent: InsertOutboundEmailResult = recipient
          ? await insertOutboundEmail(client, ctx, {
              to: [recipient],
              subject: input.title,
              body: input.body ?? '',
              classification: 'INTERNAL',
              entityType: input.entityType ?? null,
              entityId: input.entityId ?? null,
              createdBy: uid,
            })
          : { emailId: null, outcome: 'FAILED', error: 'No email address on file' };
        await client.query(
          `UPDATE notification_deliveries
              SET status = $2, provider = $3, provider_message_id = $4, error = $5,
                  sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END,
                  updated_at = now()
            WHERE id = $1`,
          [
            Number(delivery.id),
            sent.outcome === 'SENT' ? 'SENT' : 'FAILED',
            ch.toLowerCase(),
            sent.providerMessageId ?? null,
            sent.error ?? null,
          ]
        );
      }
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
    String(email.subject ?? 'HOPE DESIGN'),
    String(email.body ?? ''),
    vars
  );
}
// ---------------------------------------------------------------------------
// Delivery dispatcher (email / SMS / WhatsApp)
// ---------------------------------------------------------------------------

const RETRY_DELAYS_SECONDS = [30, 120, 600];
const MAX_DELIVERY_RETRIES = 3;
/**
 * Backoff for a provider *allowance* refusal - "quota exhausted", "rate
 * limited". The message is fine, the allowance is not, and an allowance resets
 * on its own clock (Resend's daily quota at midnight), so these are deferred
 * hourly rather than on the transport backoff above.
 */
const THROTTLE_DEFER_SECONDS = 3600;
/**
 * Ceiling on hourly allowance deferrals - 72 hours. Generous enough that a
 * forgotten top-up costs a security email hours rather than its delivery, and
 * finite so a permanently dead provider still surfaces as a FAILED row instead
 * of an eternal RETRYING one.
 */
const MAX_THROTTLE_DEFERRALS = 72;

let deliveryLoopRunning = false;

/**
 * Dispatch queued EMAIL/SMS/WHATSAPP deliveries through the configured provider (Resend for email; Africa's Talking for SMS/WhatsApp).
 * Called on an interval from the API server (single-flight). On failure the
 * delivery is retried with an exponential backoff, then marked FAILED.
 */
export async function processNotificationDeliveries(): Promise<{
  processed: number;
  ok: number;
  failed: number;
  deferred: number;
}> {
  if (deliveryLoopRunning) return { processed: 0, ok: 0, failed: 0, deferred: 0 };
  deliveryLoopRunning = true;
  try {
    // This worker runs on a timer with no request context, so row security on
    // notification_deliveries, notifications and users is fail-closed and would
    // hide every row below. The reader is a SECURITY DEFINER function that
    // returns only what it takes to send one message (migration 0174).
    const res = await query(
      `SELECT id, tenant_id, user_id, channel, recipient, retry_count,
              title, body, action_label, action_target, email, phone
         FROM get_dispatchable_notification_deliveries($1)`,
      [100]
    );
    let ok = 0;
    let failed = 0;
    // Deferred rows are not failures: the provider refused on its allowance, not
    // on the message. Counting them separately keeps the worker log honest.
    let deferred = 0;
    for (const row of res.rows as Record<string, unknown>[]) {
      const deliveryId = Number(row.id);
      // The queue is read cross-tenant, but every write below stays tenant
      // scoped: notification_deliveries and sms_messages are FORCE RLS, so the
      // row's own tenant has to be published or the policy rejects the write.
      const rowCtx: Ctx = { tenantId: Number(row.tenant_id) };
      const channel = String(row.channel);
      const fallbackProvider = channel === 'EMAIL' ? 'resend' : 'africastalking';
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
      // A spent provider allowance (Resend's daily quota, a rate limit) says
      // nothing about the message: the same send succeeds once the allowance
      // resets, so it is deferred rather than failed. Retiring the row instead is
      // what costs a security notice its delivery for good.
      const throttled = /quota|rate limit|too many|throttl/i.test(result.error ?? '');
      // A permanent refusal: nobody to send to, or the channel was never usable.
      // Retrying cannot change either.
      const terminal =
        !to || /not configured|missing|invalid|no recipient/i.test(result.error ?? '');
      if (result.ok) {
        await query(
          `UPDATE notification_deliveries
              SET status = 'SENT', provider = $1, provider_message_id = $2, sent_at = now(), error = NULL
            WHERE id = $3`,
          [result.provider ?? fallbackProvider, result.providerMessageId ?? null, deliveryId],
          rowCtx
        );
        if (channel === 'SMS') {
          await query(
            `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, provider_message_id, sent_at)
             VALUES ($1,$2,$3,$4,$5,'SENT',$6,now())`,
            [row.tenant_id, row.user_id, to, body, result.provider ?? fallbackProvider, result.providerMessageId ?? null],
            rowCtx
          );
        }
        ok += 1;
      } else {
        const attempts = Number(row.retry_count ?? 0) + 1;
        // A throttled row waits on the allowance clock rather than the transport
        // backoff, and gets a far longer budget: `attempts` still bounds it, so a
        // dead provider ends as a visible FAILED row rather than a silent loop.
        const deferSeconds = throttled
          ? THROTTLE_DEFER_SECONDS
          : RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
        const retryBudget = throttled ? MAX_THROTTLE_DEFERRALS : MAX_DELIVERY_RETRIES;
        if (!terminal && attempts <= retryBudget) {
          await query(
            `UPDATE notification_deliveries
                SET status = 'RETRYING', retry_count = $1, error = $2,
                    next_retry_at = now() + ($3::int || ' seconds')::interval
              WHERE id = $4`,
            [attempts, result.error ?? 'unknown', deferSeconds, deliveryId],
            rowCtx
          );
          if (channel === 'SMS') {
            await query(
              `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, error, retry_count)
               VALUES ($1,$2,$3,$4,$5,'RETRYING',$6,$7)`,
              [row.tenant_id, row.user_id, to, body, result.provider ?? fallbackProvider, result.error ?? 'unknown', attempts],
              rowCtx
            );
          }
        } else {
          await query(
            `UPDATE notification_deliveries
                SET status = 'FAILED', retry_count = $1, error = $2
              WHERE id = $3`,
            [attempts, result.error ?? 'unknown', deliveryId],
            rowCtx
          );
          if (channel === 'SMS') {
            await query(
              `INSERT INTO sms_messages (tenant_id, user_id, recipient, body, provider, status, error, retry_count)
               VALUES ($1,$2,$3,$4,$5,'FAILED',$6,$7)`,
              [row.tenant_id, row.user_id, to, body, result.provider ?? fallbackProvider, result.error ?? 'unknown', attempts],
              rowCtx
            );
          }
        }
        if (terminal || attempts > retryBudget) failed += 1;
        else deferred += 1;
      }
    }
    return { processed: res.rows.length, ok, failed, deferred };
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
      // Customer mail leaves through the ERP's own pipeline rather than
      // straight to the provider, so the message is stored, signed and
      // classified like every other outbound message. The call-to-action
      // button is folded into the body html, which the pipeline brand-wraps.
      const button =
        input.button && input.button.label && input.button.url ? input.button : null;
      const sent = await insertOutboundEmail(client, ctx, {
        to: [emailAddr],
        subject: input.title,
        body: input.body,
        html: button ? renderButton(button) : null,
        classification: 'PUBLIC',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      });
      out.email = { ok: sent.outcome === 'SENT', error: sent.error ?? undefined };
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
