import pg from 'pg';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import {
  isAfricasTalkingConfigured,
  sendSmsViaAfricastalking,
  sendWhatsAppViaAfricastalking,
} from './africastalking.js';
import { isResendConfigured, sendEmailViaResend } from './resend.js';
import { isMetaWhatsappConfigured, sendWhatsAppViaMetaCloud } from './metaWhatsapp.js';
import { loadCompanyProfile } from './branding.js';
import {
  brandEmailContent,
  DEFAULT_COMPANY,
  EMAIL_SOCIAL_FIELDS,
  socialLinksFromValues,
  type CompanyBrand,
  type EmailActionButton,
} from './emailBranding.js';

export interface BirdSendResult {
  ok: boolean;
  provider?: string;
  providerMessageId?: string;
  status?: string;
  error?: string;
}

/**
 * Delivery provider override. Africa's Talking carries SMS, Meta Cloud and
 * Africa's Talking both carry WhatsApp, and Resend carries email. 'auto' routes
 * each channel to its configured provider (Meta Cloud preferred for WhatsApp).
 */
export type ProviderOverride = 'auto' | 'africastalking' | 'resend' | 'meta';

export interface EmailAttachmentInput {
  /** File name shown to the recipient (extension included). */
  filename: string;
  /** Base64-encoded file bytes - Resend's `content` field. */
  content: string;
}

export interface BirdEmailInput {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  button?: EmailActionButton | null;
  preheader?: string | null;
  /** Carbon-copy recipients. */
  cc?: string[];
  /** Blind carbon-copy recipients - never disclosed to other recipients. */
  bcc?: string[];
  /** Reply-To address. */
  replyTo?: string;
  /**
   * Explicit RFC 5322 sender, e.g. `HOPE DESIGN HR <hr@hopedesign.jorlentech.com>`.
   * Set when the message is sent from a company mailbox rather than the
   * platform default sender. Falls back to the configured Resend identity.
   */
  from?: string;
  /** File attachments, base64-encoded. */
  attachments?: EmailAttachmentInput[];
  /** Overrides the tenant brand assets resolved from app_settings. */
  company?: CompanyBrand;
}

const EMAIL_BRAND_TTL_MS = 5 * 60 * 1000;
let emailBrandCache: { at: number; brand: CompanyBrand } | null = null;

/** Drop the cached brand so the next send re-reads app_settings (tests/admin). */
export function resetEmailBrandCache(): void {
  emailBrandCache = null;
}

/**
 * Resolve the tenant's branding for outgoing mail.
 *
 * These are the same app_settings rows that drive the printed, PDF and
 * spreadsheet exports, so a message always carries the uploaded logos and
 * brand colours instead of a built-in mark. A lookup failure degrades to the
 * shipped default identity rather than blocking delivery, and is never cached,
 * so a transient database error cannot pin the fallback for later sends.
 */
async function loadEmailSocials(tenantId: number, companyId: number | null) {
  const keys = EMAIL_SOCIAL_FIELDS.map((f) => f.key);
  const res = await query(
    `SELECT key, value FROM app_settings
      WHERE tenant_id = $1 AND category = 'general' AND key = ANY($2::text[])
        AND (company_id = $3 OR company_id IS NULL)
      ORDER BY (company_id IS NOT DISTINCT FROM $3) DESC`,
    [tenantId, keys, companyId],
    { tenantId, companyId }
  );
  const values: Record<string, unknown> = {};
  for (const row of res.rows as Array<{ key: string; value: unknown }>) {
    if (values[row.key] == null) values[row.key] = row.value;
  }
  return socialLinksFromValues(values);
}


export async function resolveEmailBrand(): Promise<CompanyBrand> {
  const now = Date.now();
  if (emailBrandCache && now - emailBrandCache.at < EMAIL_BRAND_TTL_MS) {
    return emailBrandCache.brand;
  }
  try {
    const tenantRow = await query<{ id: string }>('SELECT id FROM tenants ORDER BY id ASC LIMIT 1');
    const tenantId = Number(tenantRow.rows[0]?.id) || 0;
    if (!tenantId) return DEFAULT_COMPANY;
    const companyRow = await query<{ id: string }>(
      'SELECT id FROM companies WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
      [tenantId],
      { tenantId }
    );
    const companyId = Number(companyRow.rows[0]?.id) || null;
    const profile = await tx(
      (client) => loadCompanyProfile(client, { tenantId, companyId }),
      { tenantId, companyId }
    );
    const brand: CompanyBrand = {
      name: profile.name || DEFAULT_COMPANY.name,
      tagline: profile.tagline || undefined,
      address: profile.address || undefined,
      phone: profile.phone || undefined,
      email: profile.email || undefined,
      website: profile.website || undefined,
      logoUrl: profile.logoUrl || undefined,
      secondaryLogoUrl: profile.secondaryLogoUrl || undefined,
      footerLogoUrl: profile.footerLogoUrl || undefined,
      brandColor: profile.brandColor || undefined,
      brandColorSecondary: profile.brandColorSecondary || undefined,
      socials: await loadEmailSocials(tenantId, companyId),
    };
    emailBrandCache = { at: now, brand };
    return brand;
  } catch {
    return DEFAULT_COMPANY;
  }
}

export interface SmsParams {
  to: string;
  text?: string;
  from?: string;
  category?: string;
}

export interface WhatsappParams {
  to: string;
  text: { body?: string };
}

/**
 * Send an SMS through Africa's Talking - the only supported SMS provider.
 * providerOverride 'resend' is rejected: Resend does not carry SMS traffic.
 */
export async function sendSms(
  params: SmsParams,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  if (providerOverride === 'resend') {
    return { ok: false, error: "SMS is delivered through Africa's Talking only" };
  }
  if (!isAfricasTalkingConfigured()) {
    return {
      ok: false,
      error: "Africa's Talking not configured (AT_USERNAME / AT_API_KEY missing)",
    };
  }
  return sendSmsViaAfricastalking(params.to, params.text ?? '');
}

/**
 * Send a WhatsApp message, preferring the Meta WhatsApp Business Cloud API and
 * falling back to the Africa's Talking Chat API when Meta is not configured.
 * providerOverride 'resend' is rejected: Resend does not carry WhatsApp
 * traffic. providerOverride 'meta' or 'africastalking' forces that provider.
 */
export async function sendWhatsApp(
  params: WhatsappParams,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  if (providerOverride === 'resend') {
    return { ok: false, error: "WhatsApp is delivered through Meta Cloud or Africa's Talking, not Resend" };
  }
  const body = params.text?.body ?? '';
  if (!body.trim()) return { ok: false, error: 'WhatsApp message body is empty' };

  if (providerOverride === 'meta') {
    if (!isMetaWhatsappConfigured()) {
      return { ok: false, error: 'Meta WhatsApp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)' };
    }
    return sendWhatsAppViaMetaCloud({ to: params.to, text: body });
  }
  if (providerOverride === 'africastalking') {
    return sendWhatsAppViaAfricastalking(params.to, body);
  }

  // 'auto': prefer Meta Cloud, then fall back to the legacy Africa's Talking
  // Chat API so a tenant that has only migrated half-way keeps sending.
  if (isMetaWhatsappConfigured()) {
    return sendWhatsAppViaMetaCloud({ to: params.to, text: body });
  }
  if (isAfricasTalkingConfigured() && config.africastalking.whatsappNumber.trim()) {
    return sendWhatsAppViaAfricastalking(params.to, body);
  }
  return {
    ok: false,
    error: 'WhatsApp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID or AT_WHATSAPP_NUMBER missing)',
  };
}

/**
 * Send an email through Resend - the only supported email provider.
 * providerOverride 'africastalking' is rejected: Africa's Talking does not
 * carry email traffic.
 */
export async function sendEmail(
  input: BirdEmailInput,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  if (providerOverride === 'africastalking') {
    return { ok: false, error: 'Email is delivered through Resend only' };
  }
  const branded = brandEmailContent({
    subject: input.subject,
    html: input.html,
    text: input.text,
    button: input.button ?? undefined,
    preheader: input.preheader ?? undefined,
    company: input.company ?? (await resolveEmailBrand()),
  });
  const payload = { ...input, html: branded.html, text: branded.text };
  if (!isResendConfigured()) {
    return {
      ok: false,
      error: 'Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing)',
    };
  }
  return sendEmailViaResend(payload);
}

/**
 * Route a delivery by channel (EMAIL / SMS / WHATSAPP) to its configured
 * provider: Resend for email, Africa's Talking for SMS and WhatsApp.
 */
export async function dispatchBird(
  channel: string,
  to: string,
  payload: { title?: string; body?: string; button?: EmailActionButton | null }
): Promise<BirdSendResult> {
  if (!to) return { ok: false, error: 'No recipient for ' + channel + ' delivery' };
  const ch = channel.toUpperCase();
  const body = payload.body ?? payload.title ?? '';
  if (ch === 'EMAIL') {
    return sendEmail({
      to: [to],
      subject: payload.title ?? 'HOPE DESIGN',
      text: body,
      button: payload.button ?? undefined,
    });
  }
  if (ch === 'SMS') {
    return sendSms({ to, text: body });
  }
  if (ch === 'WHATSAPP') {
    return sendWhatsApp({ to, text: { body } });
  }
  return { ok: false, error: 'Unsupported channel ' + channel };
}
