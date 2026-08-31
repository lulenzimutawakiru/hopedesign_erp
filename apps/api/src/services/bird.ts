import { BirdClient, type SmsSendParams, type WhatsappSendParams } from '@messagebird/sdk';
import { config } from '../config.js';
import {
  isAfricasTalkingConfigured,
  sendSmsViaAfricastalking,
  sendWhatsAppViaAfricastalking,
} from './africastalking.js';
import { isResendConfigured, sendEmailViaResend } from './resend.js';
import { brandEmailContent } from './emailBranding.js';

export interface BirdSendResult {
  ok: boolean;
  provider?: string;
  providerMessageId?: string;
  status?: string;
  error?: string;
}

export type ProviderOverride = 'auto' | 'bird' | 'africastalking' | 'resend';

export interface BirdEmailInput {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
}

let client: BirdClient | null = null;

/**
 * Lazy Bird client. Constructing BirdClient without an API key throws, so the
 * client is only built once BIRD_API_KEY is configured (in the gitignored .env).
 */
function getClient(): BirdClient | null {
  const apiKey = (config.bird.apiKey ?? '').trim();
  if (!apiKey) return null;
  if (!client) client = new BirdClient({ apiKey });
  return client;
}

function okResult(msg: { id?: unknown; status?: unknown }): BirdSendResult {
  return {
    ok: true,
    provider: 'bird',
    providerMessageId: msg?.id != null ? String(msg.id) : undefined,
    status: msg?.status != null ? String(msg.status) : undefined,
  };
}

function errResult(err: unknown): BirdSendResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Send an SMS. Routes through Africa's Talking when its credentials are
 * configured (AT_USERNAME / AT_API_KEY), otherwise falls back to Bird.
 * Pass providerOverride = 'bird' to force Bird or 'africastalking' to force
 * Africa's Talking (e.g. from the provider test screen).
 */
export async function sendSms(
  params: SmsSendParams,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  const wantAt =
    providerOverride === 'africastalking' ||
    (providerOverride !== 'bird' && isAfricasTalkingConfigured());
  if (wantAt) return sendSmsViaAfricastalking(params.to, params.text ?? '');
  const c = getClient();
  if (!c) return { ok: false, error: 'Bird not configured (BIRD_API_KEY missing)' };
  try {
    const msg = await c.sms.send(params);
    return okResult(msg);
  } catch (err) {
    return errResult(err);
  }
}

/**
 * Send a WhatsApp message. Routes through Africa's Talking when its WhatsApp
 * virtual number is configured (AT_WHATSAPP_NUMBER), otherwise falls back to
 * Bird. Pass providerOverride = 'bird' to force Bird or 'africastalking' to
 * force Africa's Talking (e.g. from the provider test screen).
 */
export async function sendWhatsApp(
  params: WhatsappSendParams,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  const wantAt =
    providerOverride === 'africastalking' ||
    (providerOverride !== 'bird' &&
      isAfricasTalkingConfigured() &&
      Boolean(config.africastalking.whatsappNumber.trim()));
  if (wantAt) {
    const body = params.text?.body ?? '';
    if (!body.trim()) {
      return { ok: false, error: 'WhatsApp message body is empty' };
    }
    return sendWhatsAppViaAfricastalking(params.to, body);
  }
  const c = getClient();
  if (!c) return { ok: false, error: 'Bird not configured (BIRD_API_KEY missing)' };
  try {
    const msg = await c.whatsapp.send(params);
    return okResult(msg);
  } catch (err) {
    return errResult(err);
  }
}

/**
 * Send an email. Routes through Resend when its credentials are configured
 * (RESEND_API_KEY / RESEND_FROM_EMAIL), otherwise falls back to Bird.
 * Pass providerOverride = 'bird' to force Bird or 'resend' to force Resend
 * (e.g. from the provider test screen).
 */
export async function sendEmail(
  input: BirdEmailInput,
  providerOverride?: ProviderOverride
): Promise<BirdSendResult> {
  const branded = brandEmailContent({
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  const payload = { ...input, html: branded.html, text: branded.text };
  const wantResend =
    providerOverride === 'resend' || (providerOverride !== 'bird' && isResendConfigured());
  if (wantResend) return sendEmailViaResend(payload);
  const c = getClient();
  if (!c) return { ok: false, error: 'Bird not configured (BIRD_API_KEY missing)' };
  if (!payload.to?.length) return { ok: false, error: 'Email recipients missing' };
  try {
    const msg = await c.email.send({
      from: { email: config.bird.fromEmail, name: config.bird.fromName },
      to: payload.to,
      subject: payload.subject,
      ...(payload.html ? { html: payload.html } : {}),
      ...(payload.text ? { text: payload.text } : {}),
    });
    return okResult(msg);
  } catch (err) {
    return errResult(err);
  }
}

/**
 * Route a delivery by channel (EMAIL / SMS / WHATSAPP) to the Bird provider.
 * The recipient must be an email address or an E.164 phone number.
 */
export async function dispatchBird(
  channel: string,
  to: string,
  payload: { title?: string; body?: string }
): Promise<BirdSendResult> {
  if (!to) return { ok: false, error: 'No recipient for ' + channel + ' delivery' };
  const ch = channel.toUpperCase();
  const body = payload.body ?? payload.title ?? '';
  if (ch === 'EMAIL') {
    return sendEmail({
      to: [to],
      subject: payload.title ?? 'HOPE DESIGN ERP',
      text: body,
    });
  }
  if (ch === 'SMS') {
    return sendSms({
      to,
      ...(config.bird.smsFrom ? { from: config.bird.smsFrom } : {}),
      text: body,
      category: 'service',
    });
  }
  if (ch === 'WHATSAPP') {
    return sendWhatsApp({
      to,
      ...(config.bird.whatsappFrom ? { from: config.bird.whatsappFrom } : {}),
      text: { body },
    });
  }
  return { ok: false, error: 'Unsupported channel ' + channel };
}

