import pg from 'pg';
import { Ctx } from '../../db.js';
import { forbidden, notFound } from '../../utils.js';

/**
 * Email signature rendering.
 *
 * A signature is an *authorised identity artefact*: sending as someone else's
 * signature is impersonation, so the resolver only ever returns a signature the
 * caller owns, or one explicitly shared with the mailbox they are sending from.
 */

export interface MailSignature {
  id: number;
  userId: number | null;
  mailboxId: number | null;
  name: string;
  bodyText: string;
  bodyHtml: string;
  logoPath: string | null;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  website: string | null;
  social: Record<string, unknown>;
  disclaimer: string | null;
  isDefault: boolean;
  isShared: boolean;
}

export interface SignatureRenderContext {
  /** Display name of the human actually sending (never the delegator). */
  senderName?: string | null;
  onBehalfOfName?: string | null;
  companyName?: string | null;
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function toSignature(row: Record<string, unknown>): MailSignature {
  return {
    id: Number(row.id),
    userId: row.user_id == null ? null : Number(row.user_id),
    mailboxId: row.mailbox_id == null ? null : Number(row.mailbox_id),
    name: String(row.name ?? ''),
    bodyText: String(row.body_text ?? ''),
    bodyHtml: String(row.body_html ?? ''),
    logoPath: row.logo_path == null ? null : String(row.logo_path),
    jobTitle: row.job_title == null ? null : String(row.job_title),
    department: row.department == null ? null : String(row.department),
    phone: row.phone == null ? null : String(row.phone),
    website: row.website == null ? null : String(row.website),
    social: asObject(row.social),
    disclaimer: row.disclaimer == null ? null : String(row.disclaimer),
    isDefault: row.is_default === true,
    isShared: row.is_shared === true,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Signatures the caller may use when sending from `mailboxId`:
 *   - their own personal signatures
 *   - shared signatures scoped to that mailbox
 */
export async function listUsableSignatures(
  client: pg.PoolClient,
  ctx: Ctx,
  mailboxId: number | null
): Promise<MailSignature[]> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  const { rows } = await client.query(
    `SELECT * FROM email_signatures
      WHERE tenant_id = $1 AND is_active = true
        AND (
          user_id = $2
          OR ($3::bigint IS NOT NULL AND is_shared = true AND mailbox_id = $3)
        )
      ORDER BY is_default DESC, name`,
    [tenantId, userId, mailboxId]
  );
  return rows.map(toSignature);
}

/**
 * Load a specific signature for use. A caller may only use a signature they own
 * or one that is shared with the mailbox they are sending from; anything else is
 * treated as a 403 rather than a silent downgrade.
 */
export async function resolveSignature(
  client: pg.PoolClient,
  ctx: Ctx,
  signatureId: number,
  mailboxId: number | null
): Promise<MailSignature> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  const { rows } = await client.query(
    `SELECT * FROM email_signatures
      WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
    [signatureId, tenantId]
  );
  if (rows.length === 0) throw notFound('Signature not found');
  const signature = toSignature(rows[0]);
  const owned = signature.userId === userId;
  const sharedForMailbox =
    signature.isShared && mailboxId != null && signature.mailboxId === mailboxId;
  if (!owned && !sharedForMailbox) {
    throw forbidden('You may not send using this signature.');
  }
  return signature;
}

/** The default signature for a user/mailbox pair, or null when none is set. */
export async function defaultSignature(
  client: pg.PoolClient,
  ctx: Ctx,
  mailboxId: number | null
): Promise<MailSignature | null> {
  const usable = await listUsableSignatures(client, ctx, mailboxId);
  return usable.find((s) => s.isDefault) ?? null;
}

/** Plain-text block appended to the message body. */
export function renderSignatureText(
  signature: MailSignature,
  opts: SignatureRenderContext = {}
): string {
  const lines: string[] = [];
  const name = opts.senderName?.trim() || signature.name;
  lines.push(name);
  const titleParts = [signature.jobTitle, signature.department].filter(Boolean);
  if (titleParts.length) lines.push(titleParts.join(' | '));
  if (opts.companyName) lines.push(String(opts.companyName));
  if (signature.phone) lines.push(String(signature.phone));
  if (signature.website) lines.push(String(signature.website));
  if (opts.onBehalfOfName) {
    lines.push(`Sent on behalf of ${opts.onBehalfOfName}`);
  }
  if (signature.disclaimer) {
    lines.push('');
    lines.push(signature.disclaimer);
  }
  return lines.join('\n');
}

/** HTML block appended to the message body. */
export function renderSignatureHtml(
  signature: MailSignature,
  opts: SignatureRenderContext = {}
): string {
  const parts: string[] = [];
  const name = opts.senderName?.trim() || signature.name;
  parts.push(`<div style="margin-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1f2937;">`);
  parts.push(`<div style="font-weight:600;">${escapeHtml(name)}</div>`);
  const titleParts = [signature.jobTitle, signature.department].filter(Boolean);
  if (titleParts.length) {
    parts.push(`<div style="color:#4b5563;">${escapeHtml(titleParts.join(' | '))}</div>`);
  }
  if (opts.companyName) {
    parts.push(`<div style="color:#4b5563;">${escapeHtml(String(opts.companyName))}</div>`);
  }
  const contact: string[] = [];
  if (signature.phone) contact.push(escapeHtml(String(signature.phone)));
  if (signature.website) {
    const href = /^https?:\/\//i.test(String(signature.website))
      ? String(signature.website)
      : `https://${String(signature.website)}`;
    contact.push(`<a href="${escapeHtml(href)}" style="color:#0369a1;">${escapeHtml(String(signature.website))}</a>`);
  }
  if (contact.length) {
    parts.push(`<div style="color:#4b5563;">${contact.join(' &middot; ')}</div>`);
  }
  if (signature.bodyHtml) parts.push(`<div style="margin-top:8px;">${signature.bodyHtml}</div>`);
  if (opts.onBehalfOfName) {
    parts.push(`<div style="margin-top:8px;color:#6b7280;font-style:italic;">Sent on behalf of ${escapeHtml(opts.onBehalfOfName)}</div>`);
  }
  if (signature.disclaimer) {
    parts.push(`<div style="margin-top:8px;font-size:12px;color:#6b7280;">${escapeHtml(signature.disclaimer)}</div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

/**
 * Compose the final delivery body: the message plus its signature, plus any
 * "on behalf of" attribution. Returns the plain and HTML variants.
 */
export function applySignature(
  signature: MailSignature | null,
  bodyText: string,
  bodyHtml: string | null,
  opts: SignatureRenderContext = {}
): { text: string; html: string } {
  if (!signature) {
    const text = opts.onBehalfOfName
      ? `${bodyText}\n\nSent on behalf of ${opts.onBehalfOfName}`
      : bodyText;
    const html = bodyHtml
      ?? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;">${escapeHtml(bodyText).replace(/\n/g, '<br/>')}</div>`;
    return { text, html };
  }
  const baseHtml = bodyHtml
    ?? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;">${escapeHtml(bodyText).replace(/\n/g, '<br/>')}</div>`;
  return {
    text: `${bodyText}\n\n${renderSignatureText(signature, opts)}`,
    html: `${baseHtml}${renderSignatureHtml(signature, opts)}`,
  };
}