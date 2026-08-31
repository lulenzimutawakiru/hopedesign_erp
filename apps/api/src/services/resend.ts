import { config } from '../config.js';
import type { BirdEmailInput, BirdSendResult } from './bird.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * True when Resend is configured (RESEND_API_KEY and a verified sender
 * address). When enabled, email delivery is routed through Resend instead of
 * Bird.
 */
export function isResendConfigured(): boolean {
  return Boolean(config.resend.apiKey.trim() && config.resend.fromEmail.trim());
}

/**
 * Send an email through the Resend REST API.
 * Returns the same shape as the Bird providers (BirdSendResult) so callers
 * can route between providers without changing their code.
 */
export async function sendEmailViaResend(input: BirdEmailInput): Promise<BirdSendResult> {
  const { apiKey, fromEmail, fromName } = config.resend;
  if (!apiKey.trim() || !fromEmail.trim()) {
    return {
      ok: false,
      error: 'Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing)',
    };
  }
  if (!input.to?.length) return { ok: false, error: 'Email recipients missing' };
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromName.trim() ? `${fromName.trim()} <${fromEmail.trim()}>` : fromEmail.trim(),
        to: input.to,
        subject: input.subject,
        ...(input.html ? { html: input.html } : {}),
        ...(input.text ? { text: input.text } : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      let error = 'Resend error ' + res.status;
      if (typeof data?.message === 'string') error = data.message;
      else if (Array.isArray(data?.error)) {
        error = (data.error as { message?: string }[])
          .map((e) => e?.message ?? String(e))
          .join('; ');
      } else if (typeof data?.error === 'string') error = data.error;
      return { ok: false, error };
    }
    return {
      ok: true,
      provider: 'resend',
      providerMessageId: data?.id != null ? String(data.id) : undefined,
      status: String(res.status),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
