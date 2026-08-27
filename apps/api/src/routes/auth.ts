import { Router } from 'express';
import { hashToken, signAccessToken, signLoginToken, verifyLoginToken, verifyPassword, generateTotpSecret, generateTotpQrData, verifyTotp, redactUser, hashPassword } from '../auth.js';
import { query, tx } from '../db.js';
import { authenticate, loadAuthUser } from '../middleware/auth.js';
import { asyncHandler, badRequest, unauthorized } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { ApiError } from '../utils.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

function ipOf(req: import('express').Request): string {
  return req.ctx.ip || '';
}

async function recordAttempt(identifier: string, ip: string, success: boolean) {
  await query('INSERT INTO login_attempts (identifier, ip, success) VALUES ($1,$2,$3)', [identifier, ip, success]);
}

/** Create a session row; returns the raw refresh token (only its hash is stored). */
async function createSession(userId: number, tenantId: number, ip: string, ua: string, device: string, mfaVerified: boolean) {
  const crypto = await import('node:crypto');
  const raw = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const ins = await query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, device, mfa_verified_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, hashToken(raw), ip, ua, device, mfaVerified ? new Date() : null, expires],
    { tenantId, userId }
  );
  return { sid: Number(ins.rows[0].id), refreshToken: raw };
}

async function userByLogin(identifier: string) {
  const res = await query(`SELECT * FROM users WHERE email = $1 OR username = $1`, [identifier]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const mfaCode = req.body?.mfaCode ? String(req.body.mfaCode).trim() : null;
    if (!identifier || !password) throw badRequest('Identifier and password are required');

    const user = await userByLogin(identifier);
    if (!user) {
      await recordAttempt(identifier, ipOf(req), false);
      throw unauthorized('Invalid credentials');
    }
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);

    if (String(user.status) === 'LOCKED') {
      const lockedUntil = user.locked_until ? new Date(String(user.locked_until)) : null;
      if (lockedUntil && lockedUntil.getTime() > Date.now()) {
        throw new ApiError(423, 'ACCOUNT_LOCKED', 'Account is temporarily locked. Try again later.');
      }
      await query(`UPDATE users SET status='ACTIVE', failed_attempts=0, locked_until=NULL WHERE id=$1`, [userId], { tenantId, userId });
    }
    if (!['ACTIVE', 'PENDING'].includes(String(user.status))) throw unauthorized('Account is not active');

    const ok = await verifyPassword(password, String(user.password_hash));
    if (!ok) {
      const attempts = Number(user.failed_attempts ?? 0) + 1;
      if (attempts >= LOCKOUT_THRESHOLD) {
        await query(
          `UPDATE users SET failed_attempts=$2, locked_until=now() + ($3 || ' minutes')::interval, status='LOCKED' WHERE id=$1`,
          [userId, attempts, LOCKOUT_MINUTES], { tenantId, userId }
        );
        await recordAttempt(identifier, ipOf(req), false);
        throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Account locked.');
      }
      await query(`UPDATE users SET failed_attempts=$2 WHERE id=$1`, [userId, attempts], { tenantId, userId });
      await recordAttempt(identifier, ipOf(req), false);
      throw unauthorized('Invalid credentials');
    }

    await query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [userId], { tenantId, userId });
    await recordAttempt(identifier, ipOf(req), true);

    if (Boolean(user.mfa_enabled)) {
      if (!mfaCode) {
        const loginToken = signLoginToken(userId, tenantId);
        return res.json({ mfaRequired: true, loginToken, user: redactUser(user) });
      }
      const secret = String(user.mfa_secret ?? '');
      if (!secret || !verifyTotp(secret, mfaCode)) throw badRequest('Invalid MFA code');
      const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
      const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
      await tx(async (client) => {
        await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'login_mfa', resource: 'auth', recordId: userId });
      }, { tenantId, userId });
      return res.json({ accessToken, refreshToken, user: redactUser(user) });
    }

    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'login', resource: 'auth', recordId: userId });
    }, { tenantId, userId });
    res.json({ accessToken, refreshToken, user: redactUser(user) });
  })
);
// ---------------------------------------------------------------- accept invitation
authRouter.post(
  '/accept-invite',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!token) throw badRequest('Invitation token is required');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    const inv = (
      await query('SELECT * FROM user_invitations WHERE token_hash = $1', [hashToken(token)])
    ).rows[0] as Record<string, unknown> | undefined;
    if (!inv) throw unauthorized('Invalid or expired invitation');
    if (String(inv.status) !== 'PENDING' || inv.revoked_at) throw unauthorized('Invitation has already been used or revoked');
    const expiresAt = inv.expires_at ? new Date(String(inv.expires_at)) : new Date(0);
    if (expiresAt.getTime() < Date.now()) throw unauthorized('Invitation has expired');
    const userId = Number(inv.user_id);
    const tenantId = Number(inv.tenant_id);
    const userRes = await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId]);
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    if (!['INVITED', 'PENDING_ACTIVATION', 'PENDING'].includes(String(user.status))) {
      throw unauthorized('Account is not pending activation');
    }
    const hash = await hashPassword(password);
    await query(
      `UPDATE users SET password_hash=$1, status='ACTIVE', must_change_password=false, failed_attempts=0,
              password_changed_at=now(), last_login_at=now() WHERE id=$2`,
      [hash, userId],
      { tenantId, userId }
    );
    await query(
      `UPDATE user_invitations SET status='ACCEPTED', accepted_at=now(), updated_at=now() WHERE id=$1`,
      [inv.id],
      { tenantId, userId }
    );
    await query(
      `INSERT INTO user_status_history (tenant_id, user_id, from_status, to_status, reason, changed_by)
       VALUES ($1,$2,$3,'ACTIVE','Invitation accepted',NULL)`,
      [tenantId, userId, String(user.status)]
    );
    const fresh = (
      await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId])
    ).rows[0] as Record<string, unknown>;
    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'accept_invite', resource: 'users', recordId: userId });
    }, { tenantId, userId });
    res.json({ accessToken, refreshToken, user: redactUser(fresh) });
  })
);
// ---------------------------------------------------------------- MFA verify (login token flow)
authRouter.post(
  '/mfa/verify',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.loginToken ?? '');
    const code = String(req.body?.code ?? '').trim();
    if (!token || !code) throw badRequest('loginToken and code are required');
    let payload;
    try {
      payload = verifyLoginToken(token);
    } catch {
      throw unauthorized('Invalid login token');
    }
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid]);
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    if (!Boolean(user.mfa_enabled)) throw badRequest('MFA is not enabled for this account');
    const secret = String(user.mfa_secret ?? '');
    if (!secret || !verifyTotp(secret, code)) throw badRequest('Invalid MFA code');

    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'login_mfa', resource: 'auth', recordId: userId });
    }, { tenantId, userId });
    res.json({ accessToken, refreshToken, user: redactUser(user) });
  })
);

// ---------------------------------------------------------------- MFA setup (authenticated)
authRouter.post(
  '/mfa/setup',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    if (user.mfa_enabled) throw badRequest('MFA is already enabled');
    const secret = generateTotpSecret();
    await query(`UPDATE users SET mfa_secret=$1, mfa_method='TOTP' WHERE id=$2`, [secret, user.id], { tenantId: user.tenant_id, userId: user.id });
    res.json({ secret, otpauthUrl: generateTotpQrData(user.email, secret) });
  })
);

authRouter.post(
  '/mfa/confirm',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const code = String(req.body?.code ?? '').trim();
    const secret = String(req.body?.secret ?? '');
    if (!code) throw badRequest('Verification code is required');
    const stored = await query(`SELECT mfa_secret FROM users WHERE id=$1`, [user.id], { tenantId: user.tenant_id, userId: user.id });
    const s = secret || String(stored.rows[0]?.mfa_secret ?? '');
    if (!s || !verifyTotp(s, code)) throw badRequest('Invalid MFA code');
    await query(`UPDATE users SET mfa_enabled=true, mfa_secret=$1 WHERE id=$2`, [s, user.id], { tenantId: user.tenant_id, userId: user.id });
    res.json({ mfaEnabled: true });
  })
);

// ---------------------------------------------------------------- logout
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const refresh = req.body?.refreshToken ? String(req.body.refreshToken) : null;
    if (refresh) {
      await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(refresh)]);
    } else if (bearer) {
      try {
        const { verifyAccessToken } = await import('../auth.js');
        const payload = verifyAccessToken(bearer);
        if (payload.sid) await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [payload.sid]);
      } catch { /* token already invalid */ }
    }
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- me
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const unread = await query(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND read_at IS NULL`,
      [user.id], { tenantId: user.tenant_id, userId: user.id }
    );
    res.json({ user, unreadNotifications: Number(unread.rows[0].c) });
  })
);

// ---------------------------------------------------------------- change password
authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    if (next.length < 8) throw badRequest('New password must be at least 8 characters');
    const row = (await query(`SELECT password_hash FROM users WHERE id=$1`, [user.id], { tenantId: user.tenant_id, userId: user.id })).rows[0] as { password_hash: string };
    const ok = await verifyPassword(current, row.password_hash);
    if (!ok) throw badRequest('Current password is incorrect');
    const hash = await hashPassword(next);
    await query(
      `UPDATE users SET password_hash=$1, must_change_password=false, password_changed_at=now() WHERE id=$2`,
      [hash, user.id], { tenantId: user.tenant_id, userId: user.id }
    );
    await tx(async (client) => {
      await logAudit(client, { tenantId: user.tenant_id, userId: user.id, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'change_password', resource: 'users', recordId: user.id });
    }, { tenantId: user.tenant_id, userId: user.id });
    res.json({ ok: true });
  })
);
