// MFA-004: WhatsApp sign-in codes. These are database-backed, mirroring the
// "MFA email one-time codes" suite in auth.test.ts, and exercise issueWhatsAppCode
// against the same shared code store. Delivery is stubbed so no live WhatsApp
// gateway is ever reached.
import { describe, it, expect } from 'vitest';
import { db, PASSWORD } from './helpers.js';
import { issueWhatsAppCode, verifyEmailCode } from '../src/services/mfaEmail.js';

describe('MFA WhatsApp one-time codes', () => {
  const stamp = Date.now();

  /** Throwaway account in tenant 2 so the code path never touches seeded users. */
  async function createWaUser(phone: string) {
    const { hashPassword } = await import('../src/auth.js');
    const passwordHash = await hashPassword(PASSWORD);
    const username = `wa.path.${stamp}.${Math.random().toString(36).slice(2, 8)}`;
    const email = `${username}@hopedesign.test`;
    const ins = await db(
      `INSERT INTO users (tenant_id, company_id, email, username, password_hash, first_name, last_name)
       VALUES (2, 2, $1, $2, $3, 'WhatsApp', 'Path') RETURNING id`,
      [email, username, passwordHash]
    );
    return { userId: Number(ins.rows[0].id), phone };
  }

  async function dropWaUser(userId: number) {
    await db(`DELETE FROM mfa_email_codes WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  it('issues a single-use code and stores the WhatsApp channel + phone', async () => {
    const { userId, phone } = await createWaUser('+256712345678');
    try {
      let sent = '';
      const issued = await issueWhatsAppCode({
        tenantId: 2,
        userId,
        phone,
        name: 'WhatsApp Path',
        purpose: 'LOGIN',
        send: async (d) => {
          sent = d.code;
          return { ok: true };
        },
      });
      expect(issued.ok).toBe(true);
      expect(sent).toMatch(/^\d{6}$/);

      // The shared code store records the channel and the destination phone,
      // not just an email-shaped value.
      const row = await db(
        `SELECT channel, phone FROM mfa_email_codes WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId]
      );
      expect(String(row.rows[0].channel)).toBe('WHATSAPP');
      expect(String(row.rows[0].phone)).toBe(phone);

      const verified = await verifyEmailCode({ tenantId: 2, userId, code: sent });
      expect(verified.ok).toBe(true);
      expect(verified.purpose).toBe('LOGIN');
    } finally {
      await dropWaUser(userId);
    }
  });

  it('fails closed and burns the code when WhatsApp delivery fails', async () => {
    const { userId, phone } = await createWaUser('+256712345678');
    try {
      let sent = '';
      const failed = await issueWhatsAppCode({
        tenantId: 2,
        userId,
        phone,
        name: 'WhatsApp Path',
        purpose: 'LOGIN',
        send: async (d) => {
          sent = d.code;
          return { ok: false, error: 'WhatsApp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)' };
        },
      });
      expect(failed.ok).toBe(false);
      expect(String(failed.error)).toMatch(/not configured/i);
      // The plaintext code must never reach the caller on failure.
      expect(failed.code).toBeUndefined();

      // Nothing usable survives, so an undelivered code can never be guessed.
      const open = await db(
        `SELECT count(*)::int AS n FROM mfa_email_codes WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId]
      );
      expect(Number(open.rows[0].n)).toBe(0);
      const verified = await verifyEmailCode({ tenantId: 2, userId, code: sent });
      expect(verified.ok).toBe(false);
      expect(verified.error).toBe('no_active_code');
    } finally {
      await dropWaUser(userId);
    }
  });
});
