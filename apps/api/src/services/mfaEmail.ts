import { config } from '../config.js';
import { query } from '../db.js';
import { generateEmailOtp, hashOtp, safeEqualHex } from '../auth.js';
import { sendEmail } from './bird.js';

/**
 * MFA-002 - emailed one-time sign-in codes.
 *
 * The code is generated here, hashed into mfa_email_codes, and handed to the
 * delivery provider. The plaintext value is returned to the *caller* only so a
 * unit test can supply a stub sender; routes must never forward it to a client
 * and nothing in this module writes it to a log.
 */

export type EmailCodePurpose = 'LOGIN' | 'ENROLL' | 'CHANGE_EMAIL';

export interface EmailCodeDelivery {
  to: string;
  name: string;
  code: string;
  purpose: EmailCodePurpose;
  ttlMinutes: number;
}

export type EmailCodeSender = (delivery: EmailCodeDelivery) => Promise<{ ok: boolean; error?: string }>;

const PURPOSE_COPY: Record<EmailCodePurpose, string> = {
  LOGIN: 'sign in to HOPE DESIGN',
  ENROLL: 'confirm this address and finish setting up two-step verification',
  CHANGE_EMAIL: 'confirm your new sign-in email address',
};

const defaultSender: EmailCodeSender = async ({ to, name, code, purpose, ttlMinutes }) => {
  const greeting = name.trim() ? `Hello ${name.trim()},` : 'Hello,';
  const text = [
    greeting,
    '',
    `Your one-time code to ${PURPOSE_COPY[purpose]} is: ${code}`,
    '',
    `It expires in ${ttlMinutes} minutes and can only be used once.`,
    'If you did not try to sign in, do not share this code - change your password and tell your system administrator.',
    '',
    'HOPE DESIGN GROUP LTD',
  ].join('\n');
  const res = await sendEmail({
    to: [to],
    subject: `${code} is your HOPE DESIGN sign-in code`,
    text,
    preheader: `Your one-time code expires in ${ttlMinutes} minutes.`,
  });
  return { ok: res.ok, error: res.error };
};

export interface IssueEmailCodeOptions {
  tenantId: number;
  userId: number;
  email: string;
  name?: string | null;
  purpose?: EmailCodePurpose;
  ip?: string | null;
  userAgent?: string | null;
  /** Injected in tests; defaults to the branded Resend delivery. */
  send?: EmailCodeSender;
}

export interface IssueEmailCodeResult {
  ok: boolean;
  /** Plaintext code. Test-only surface - routes must not return this. */
  code?: string;
  expiresAt?: Date;
  expiresInMinutes?: number;
  /** A live code already exists; seconds until a new one may be requested. */
  alreadySent?: boolean;
  resendAfterSeconds?: number;
  error?: string;
}

/**
 * Issue (or reuse) a sign-in code for a user.
 *
 * Anti-abuse: while an unexpired code is inside the resend cooldown the existing
 * code is kept and no further mail is sent, so a client cannot turn the login
 * screen into a mail amplifier against the holder's inbox.
 */
export async function issueEmailCode(opts: IssueEmailCodeOptions): Promise<IssueEmailCodeResult> {
  const purpose: EmailCodePurpose = opts.purpose ?? 'LOGIN';
  const ttl = config.mfa.emailCodeTtlMinutes;
  const cooldownMs = config.mfa.emailCodeResendSeconds * 1000;

  const openRes = await query(
    `SELECT id, created_at, expires_at
       FROM mfa_email_codes
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [opts.userId, purpose],
    { tenantId: opts.tenantId, userId: opts.userId }
  );
  const open = openRes.rows[0] as { id: number; created_at: Date; expires_at: Date } | undefined;
  if (open) {
    const ageMs = Date.now() - new Date(open.created_at).getTime();
    const waitSeconds = Math.ceil((cooldownMs - ageMs) / 1000);
    if (waitSeconds > 0) {
      return {
        ok: true,
        alreadySent: true,
        resendAfterSeconds: waitSeconds,
        expiresAt: new Date(open.expires_at),
      };
    }
  }

  const code = generateEmailOtp();
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  // Supersede every earlier open code for this user (any purpose): at most one
  // usable code can exist, so a stolen older mail cannot be replayed.
  await query(
    `UPDATE mfa_email_codes SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [opts.userId],
    { tenantId: opts.tenantId, userId: opts.userId }
  );

  await query(
    `INSERT INTO mfa_email_codes
       (tenant_id, user_id, email, code_hash, purpose, expires_at, max_attempts, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      opts.tenantId,
      opts.userId,
      opts.email,
      hashOtp(code),
      purpose,
      expiresAt,
      config.mfa.emailCodeMaxAttempts,
      opts.ip ?? null,
      opts.userAgent ?? null,
    ],
    { tenantId: opts.tenantId, userId: opts.userId }
  );

  const sender = opts.send ?? defaultSender;
  const delivered = await sender({
    to: opts.email,
    name: String(opts.name ?? ''),
    code,
    purpose,
    ttlMinutes: ttl,
  });

  if (!delivered.ok) {
    // Burn the undeliverable code so it can never be guessed into a session.
    await query(
      `UPDATE mfa_email_codes SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [opts.userId],
      { tenantId: opts.tenantId, userId: opts.userId }
    );
    return { ok: false, error: delivered.error ?? 'Email delivery failed' };
  }

  return { ok: true, code, expiresAt, expiresInMinutes: ttl, resendAfterSeconds: config.mfa.emailCodeResendSeconds };
}

export type EmailCodeVerifyError =
  | 'invalid_format'
  | 'no_active_code'
  | 'too_many_attempts'
  | 'invalid_code';

export interface VerifyEmailCodeResult {
  ok: boolean;
  purpose?: EmailCodePurpose;
  /** Address the verified code was delivered to (used by CHANGE_EMAIL). */
  email?: string;
  error?: EmailCodeVerifyError;
}

/**
 * Verify a submitted code against the newest open code for a user.
 * Attempts are counted on the stored row so an attacker cannot grind a code.
 */
export async function verifyEmailCode(opts: {
  tenantId: number;
  userId: number;
  code: string;
}): Promise<VerifyEmailCodeResult> {
  const code = String(opts.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'invalid_format' };

  const res = await query(
    `SELECT id, code_hash, purpose, email, attempts, max_attempts
       FROM mfa_email_codes
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [opts.userId],
    { tenantId: opts.tenantId, userId: opts.userId }
  );
  const row = res.rows[0] as
    | { id: number; code_hash: string; purpose: string; email: string; attempts: number; max_attempts: number }
    | undefined;
  if (!row) return { ok: false, error: 'no_active_code' };

  if (Number(row.attempts) >= Number(row.max_attempts)) {
    await query(`UPDATE mfa_email_codes SET consumed_at = now() WHERE id = $1`, [row.id], {
      tenantId: opts.tenantId,
      userId: opts.userId,
    });
    return { ok: false, error: 'too_many_attempts' };
  }

  if (!safeEqualHex(hashOtp(code), String(row.code_hash))) {
    await query(`UPDATE mfa_email_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL`, [row.id], {
      tenantId: opts.tenantId,
      userId: opts.userId,
    });
    return { ok: false, error: 'invalid_code' };
  }

  const consumed = await query(
    `UPDATE mfa_email_codes SET consumed_at = now(), attempts = attempts + 1
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING id`,
    [row.id],
    { tenantId: opts.tenantId, userId: opts.userId }
  );
  // Lost the race to another request - treat as already used.
  if (consumed.rows.length === 0) return { ok: false, error: 'no_active_code' };

  return { ok: true, purpose: String(row.purpose) as EmailCodePurpose, email: String(row.email) };
}

/** Invalidate every open code for a user (used after a successful sign-in). */
export async function clearEmailCodes(tenantId: number, userId: number) {
  await query(`UPDATE mfa_email_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [userId], {
    tenantId,
    userId,
  });
}

/** Basic but strict address shape check shared by the API routes. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;