import { config } from '../config.js';
import type { BirdEmailInput, BirdSendResult } from './bird.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/** Pull the provider's message out of a failed response body. */
function extractResendError(res: Response, data: Record<string, unknown> | null): string {
  if (typeof data?.message === 'string') return data.message;
  if (Array.isArray(data?.error)) {
    return (data.error as { message?: string }[]).map((e) => e?.message ?? String(e)).join('; ');
  }
  if (typeof data?.error === 'string') return data.error;
  return 'Resend error ' + res.status;
}

/**
 * Retry policy for the Resend POST.
 *
 * A sign-in code that dies on a transient refusal locks the user out of the
 * ERP, so a send is retried a bounded number of times before it is reported as
 * failed. Resend answers 429 for two very different things: its per-second
 * rate limit (retryable - a burst of people signing in at once) and an
 * exhausted daily quota (not retryable: waiting a second cannot restore a
 * spent day), so the quota case short-circuits instead of burning the caller's
 * time. 5xx and transport errors are always retried.
 *
 * A retry can duplicate a message the provider accepted but never
 * acknowledged. For the sign-in codes that costs least, because issuing a code
 * supersedes every earlier open code for that user.
 */
const RESEND_MAX_ATTEMPTS = 3;
const RESEND_RETRY_BASE_MS = 400;
const RESEND_MAX_RETRY_MS = 5000;
const RESEND_QUOTA_ERROR =
  /daily[_ ]?quota|sending quota|quota.{0,20}exceed|exceed.{0,20}quota|per day/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True when Resend is configured (RESEND_API_KEY and a verified sender
 * address). Resend is the only email delivery provider.
 */
export function isResendConfigured(): boolean {
  return Boolean(config.resend.apiKey.trim() && config.resend.fromEmail.trim());
}

/**
 * Send an email through the Resend REST API.
 * Returns the shared provider result shape so callers can route without
 * changing their code.
 */
/**
 * Resolve the RFC 5322 `from` header.
 *
 * A per-message sender (a company mailbox identity) always wins over the
 * platform default so department mail leaves from the department address.
 * The value is normalised to `Name <address>` when a bare address is given.
 */
function resolveFrom(input: BirdEmailInput, fromName: string, fromEmail: string): string {
  const explicit = input.from?.trim();
  if (explicit) return explicit;
  const name = fromName.trim();
  const address = fromEmail.trim();
  return name ? `${name} <${address}>` : address;
}

export async function sendEmailViaResend(input: BirdEmailInput): Promise<BirdSendResult> {
  const { apiKey, fromEmail, fromName } = config.resend;
  if (!apiKey.trim() || !fromEmail.trim()) {
    return {
      ok: false,
      error: 'Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing)',
    };
  }
  if (!input.to?.length) return { ok: false, error: 'Email recipients missing' };

  const body = JSON.stringify({
    from: resolveFrom(input, fromName, fromEmail),
    to: input.to,
    subject: input.subject,
    ...(input.html ? { html: input.html } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    ...(input.replyTo?.trim() ? { reply_to: input.replyTo.trim() } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });

  let lastError = 'Resend error';
  for (let attempt = 1; attempt <= RESEND_MAX_ATTEMPTS; attempt += 1) {
    const backoffMs = Math.min(RESEND_RETRY_BASE_MS * 2 ** (attempt - 1), RESEND_MAX_RETRY_MS);
    try {
      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey.trim(),
          'Content-Type': 'application/json',
        },
        body,
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok) {
        return {
          ok: true,
          provider: 'resend',
          providerMessageId: data?.id != null ? String(data.id) : undefined,
          status: String(res.status),
        };
      }

      lastError = extractResendError(res, data);
      const retryable =
        res.status >= 500 || (res.status === 429 && !RESEND_QUOTA_ERROR.test(lastError));
      if (!retryable || attempt === RESEND_MAX_ATTEMPTS) return { ok: false, error: lastError };

      // Honour a provider-supplied Retry-After when it is short enough to wait out.
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RESEND_MAX_RETRY_MS)
          : backoffMs;
      await sleep(waitMs);
    } catch (err) {
      // A thrown fetch is a transport failure (DNS, reset, timeout): retryable.
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === RESEND_MAX_ATTEMPTS) return { ok: false, error: lastError };
      await sleep(backoffMs);
    }
  }
  return { ok: false, error: lastError };
}
