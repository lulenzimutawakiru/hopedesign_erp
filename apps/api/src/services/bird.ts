import pg from 'pg';
import { pool, query } from '../db.js';
import {
  isAfricasTalkingConfigured,
  sendSmsViaAfricastalking,
  sendWhatsAppViaAfricastalking,
} from './africastalking.js';
import { isResendConfigured, sendEmailViaResend } from './resend.js';
import { loadCompanyProfile } from './branding.js';
import {
  brandEmailContent,
  DEFAULT_COMPANY,
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
 * Delivery provider override. Africa's Talking is the only SMS/WhatsApp
 * provider and Resend is the only email provider. 'auto' routes each channel
 * to its single configured provider.
 */
export type ProviderOverride = 'auto' | 'africastalking' | 'resend';

export interface BirdEmailInput {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  button?: EmailActionButton | null;
  preheader?: string | null;
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
    const profile = await loadCompanyProfile(pool as unknown as pg.PoolClient, {
      tenantId,
      companyId,
    });
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
 * Send a WhatsApp message through the Africa's Talking Chat API - the only
 * supported WhatsApp provider. Requires AT_WHATSAPP_NUMBER.
 */
export async function sendWhatsApp(
  params: WhatsappParams,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  if (providerOverride === 'resend') {
    return { ok: false, error: "WhatsApp is delivered through Africa's Talking only" };
  }
  const body = params.text?.body ?? '';
  if (!body.trim()) return { ok: false, error: 'WhatsApp message body is empty' };
  return sendWhatsAppViaAfricastalking(params.to, body);
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
