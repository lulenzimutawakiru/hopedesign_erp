import { config } from '../config.js';
import type { BirdSendResult } from './bird.js';

const AT_API_URL = 'https://api.africastalking.com/version1/messaging';
const AT_WHATSAPP_URL = 'https://chat.africastalking.com/whatsapp/message/send';

/**
 * True when Africa's Talking SMS credentials are configured. When enabled,
 * SMS delivery is routed through Africa's Talking instead of Bird.
 */
export function isAfricasTalkingConfigured(): boolean {
  return Boolean(config.africastalking.apiKey.trim() && config.africastalking.username.trim());
}

/**
 * Normalize a phone number to E.164 for Africa's Talking.
 * Accepts +256712345678, 256712345678, 0712345678 or 712345678 (Uganda mobile).
 * Numbers already in international format are returned unchanged.
 */
export function normalizeE164(raw: string): string {
  const cleaned = String(raw ?? '').replace(/[\s()-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('256')) return '+' + cleaned;
  if (cleaned.startsWith('0')) return '+256' + cleaned.slice(1);
  if (/^7\d{8}$/.test(cleaned)) return '+256' + cleaned;
  return cleaned;
}

/**
 * Send an SMS through the Africa's Talking REST API.
 * Returns the same shape as the Bird providers (BirdSendResult) so callers
 * can route between providers without changing their code.
 */
export async function sendSmsViaAfricastalking(to: string, text: string): Promise<BirdSendResult> {
  const { apiKey, username, senderId } = config.africastalking;
  if (!apiKey.trim() || !username.trim()) {
    return { ok: false, error: "Africa's Talking not configured (AT_API_KEY / AT_USERNAME missing)" };
  }
  const recipient = normalizeE164(to);
  if (!recipient) return { ok: false, error: 'SMS recipient missing' };
  const form = new URLSearchParams({
    username: username.trim(),
    to: recipient,
    message: text,
  });
  if (senderId.trim()) form.set('from', senderId.trim());
  try {
    const res = await fetch(AT_API_URL, {
      method: 'POST',
      headers: {
        apiKey: apiKey.trim(),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => null)) as {
      SMSMessageData?: { Message?: string; Recipients?: { status?: string; messageId?: string }[] };
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: String(data?.SMSMessageData?.Message ?? "Africa's Talking error " + res.status),
      };
    }
    const recipients = data?.SMSMessageData?.Recipients;
    const first = Array.isArray(recipients) && recipients.length ? recipients[0] : undefined;
    if (!first || String(first.status ?? '').toUpperCase() !== 'SUCCESS') {
      return {
        ok: false,
        error: String(first?.status ?? data?.SMSMessageData?.Message ?? "Africa's Talking send failed"),
      };
    }
    return {
      ok: true,
      provider: 'africastalking',
      providerMessageId: first.messageId ? String(first.messageId) : undefined,
      status: String(first.status),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send a WhatsApp message through the Africa's Talking Chat API.
 * Requires the AT-issued WhatsApp virtual number (AT_WHATSAPP_NUMBER).
 * Returns the same shape as the Bird providers (BirdSendResult).
 */
export async function sendWhatsAppViaAfricastalking(to: string, text: string): Promise<BirdSendResult> {
  const { apiKey, username, whatsappNumber } = config.africastalking;
  if (!apiKey.trim() || !username.trim()) {
    return { ok: false, error: "Africa's Talking not configured (AT_API_KEY / AT_USERNAME missing)" };
  }
  if (!whatsappNumber.trim()) {
    return {
      ok: false,
      error: "Africa's Talking WhatsApp not configured (AT_WHATSAPP_NUMBER missing)",
    };
  }
  const recipient = normalizeE164(to);
  if (!recipient) return { ok: false, error: 'WhatsApp recipient missing' };
  try {
    const res = await fetch(AT_WHATSAPP_URL, {
      method: 'POST',
      headers: {
        apiKey: apiKey.trim(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: username.trim(),
        waNumber: whatsappNumber.trim(),
        phoneNumber: recipient,
        body: { message: text },
      }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        ok: false,
        error: String(
          data?.error ?? data?.message ?? "Africa's Talking WhatsApp error " + res.status
        ),
      };
    }
    return {
      ok: true,
      provider: 'africastalking',
      providerMessageId: data?.messageId != null ? String(data.messageId) : undefined,
      status: data?.status != null ? String(data.status) : 'Submitted',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
