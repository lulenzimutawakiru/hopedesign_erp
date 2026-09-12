import { Router } from 'express';
import { hashToken, signAccessToken, signLoginToken, verifyLoginToken, verifyPassword, generateTotpSecret, totpEnrollmentPayload, verifyTotp, redactUser, hashPassword, maskEmail } from '../auth.js';
import { query, tx } from '../db.js';
import { authenticate, loadAuthUser } from '../middleware/auth.js';
import { asyncHandler, badRequest, unauthorized } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { loginLimiter, mfaLimiter, inviteLimiter } from '../middleware/rateLimits.js';
import { ApiError } from '../utils.js';
import { config } from '../config.js';
import { issueEmailCode, verifyEmailCode, clearEmailCodes, EMAIL_RE } from '../services/mfaEmail.js';

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
  // DB-001 (Phase 2B): identity is resolved before a tenant context exists, so
  // pre-login lookups run through a SECURITY DEFINER helper (0128); under the
  // least-privilege app role a raw table query would be RLS fail-closed.
  const res = await query(`SELECT * FROM auth_resolve_user_by_identifier($1)`, [identifier]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

/**
 * True when the user holds any permission that warrants mandatory MFA.
 * Privileged families: administration, finance, security printing, HR payroll.
 */
async function userHoldsPrivilegedPermission(userId: number, tenantId: number): Promise<boolean> {
  const permsRes = await query(
    `SELECT DISTINCT p.code
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [userId],
    { tenantId, userId }
  );
  const perms = (permsRes.rows as { code: string }[]).map((r) => r.code);
  return perms.some((code) => {
    if (code === 'system.admin.all' || code === '*') return true;
    return (
      code.startsWith('admin.') ||
      code.startsWith('finance.') ||
      code.startsWith('security_printing.') ||
      code.startsWith('hr.payrolls.')
    );
  });
}

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
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

    // AUTH-001 / MFA-002: a second factor must be satisfied before a session is
    // issued. `mfa_method` selects the challenge:
    //   EMAIL -> a six-digit code mailed to the holder's personal address
    //   TOTP  -> the authenticator-app code, retained for already-enrolled users
    // Accounts with no usable second factor that hold privileged permissions are
    // routed to enrollment instead of straight into a session.
    const personalEmail = String(user.personal_email ?? '').trim();
    const mfaMethod = String(user.mfa_method ?? '').toUpperCase();
    const emailMfaReady = Boolean(user.mfa_enabled) && mfaMethod === 'EMAIL' && personalEmail.length > 0;
    const totpMfaReady = Boolean(user.mfa_enabled) && Boolean(String(user.mfa_secret ?? ''));

    if (emailMfaReady || totpMfaReady) {
      if (emailMfaReady) {
        if (!mfaCode) {
          const issued = await issueEmailCode({
            tenantId,
            userId,
            email: personalEmail,
            name: [user.first_name, user.last_name].filter(Boolean).join(' '),
            purpose: 'LOGIN',
            ip: ipOf(req),
            userAgent: req.ctx.userAgent,
          });
          if (!issued.ok) {
            throw new ApiError(503, 'EMAIL_DELIVERY_FAILED', 'We could not send your sign-in code. Please try again shortly.');
          }
          return res.json({
            mfaRequired: true,
            method: 'email',
            maskedEmail: maskEmail(personalEmail),
            alreadySent: Boolean(issued.alreadySent),
            resendAfterSeconds: issued.resendAfterSeconds ?? config.mfa.emailCodeResendSeconds,
            loginToken: signLoginToken(userId, tenantId),
            user: redactUser(user),
          });
        }
        const verified = await verifyEmailCode({ tenantId, userId, code: mfaCode });
        if (!verified.ok) throw badRequest('Invalid MFA code');
        await clearEmailCodes(tenantId, userId);
      } else {
        if (!mfaCode) {
          return res.json({ mfaRequired: true, method: 'totp', loginToken: signLoginToken(userId, tenantId), user: redactUser(user) });
        }
        const secret = String(user.mfa_secret ?? '');
        if (!secret || !verifyTotp(secret, mfaCode)) throw badRequest('Invalid MFA code');
      }
      const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
      const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
      await tx(async (client) => {
        await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, {
          action: 'login_mfa',
          resource: 'auth',
          recordId: userId,
          metadata: { method: emailMfaReady ? 'EMAIL' : 'TOTP' },
        });
      }, { tenantId, userId });
      return res.json({ accessToken, refreshToken, user: redactUser(user) });
    }

    // MFA-002: mfa_enabled is only meaningful when a usable factor exists.
    // A row can be flagged enabled yet hold neither a personal address nor a
    // TOTP secret, in which case the challenge above cannot run. Enrolment is
    // forced instead of issuing a session that silently skipped the factor.
    if (Boolean(user.mfa_enabled) || (await userHoldsPrivilegedPermission(userId, tenantId))) {
      return res.json({
        mfaRequired: true,
        enrollmentRequired: true,
        method: 'email',
        loginToken: signLoginToken(userId, tenantId),
        user: redactUser(user),
      });
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
  inviteLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!token) throw badRequest('Invitation token is required');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    const inv = (
      await query('SELECT * FROM auth_invitation_by_token_hash($1)', [hashToken(token)])
    ).rows[0] as Record<string, unknown> | undefined;
    if (!inv) throw unauthorized('Invalid or expired invitation');
    if (String(inv.status) !== 'PENDING' || inv.revoked_at) throw unauthorized('Invitation has already been used or revoked');
    const expiresAt = inv.expires_at ? new Date(String(inv.expires_at)) : new Date(0);
    if (expiresAt.getTime() < Date.now()) throw unauthorized('Invitation has expired');
    const userId = Number(inv.user_id);
    const tenantId = Number(inv.tenant_id);
    const userRes = await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId], { tenantId, userId });
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
      [tenantId, userId, String(user.status)],
      { tenantId, userId }
    );
    const fresh = (
      await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId], { tenantId, userId })
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
  mfaLimiter,
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
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid], { tenantId: payload.tid, userId: payload.sub });
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    const method = String(user.mfa_method ?? '').toUpperCase();
    const emailReady = method === 'EMAIL' && String(user.personal_email ?? '').trim().length > 0;
    if (!Boolean(user.mfa_enabled) && !emailReady) throw badRequest('MFA is not enabled for this account');
    if (emailReady) {
      // The code itself proves control of the mailbox, so an account part-way
      // through email enrollment may still complete here.
      const verified = await verifyEmailCode({ tenantId, userId, code });
      if (!verified.ok) throw badRequest('Invalid MFA code');
      await clearEmailCodes(tenantId, userId);
    } else {
      const secret = String(user.mfa_secret ?? '');
      if (!secret || !verifyTotp(secret, code)) throw badRequest('Invalid MFA code');
    }

    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'login_mfa', resource: 'auth', recordId: userId });
    }, { tenantId, userId });
    res.json({ accessToken, refreshToken, user: redactUser(user) });
  })
);

// ---------------------------------------------------------------- MFA email code (login token flow)
/**
 * MFA-002: begin (or repeat) an emailed challenge from the pre-session login
 * token. Passing `email` enrolls that address; omitting it re-sends to the
 * address already on file. The plaintext code is never returned to the client.
 */
authRouter.post(
  '/mfa/email/start',
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.loginToken ?? '');
    const supplied = String(req.body?.email ?? '').trim().toLowerCase();
    if (!token) throw badRequest('loginToken is required');
    let payload;
    try {
      payload = verifyLoginToken(token);
    } catch {
      throw unauthorized('Invalid login token');
    }
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid], { tenantId: payload.tid, userId: payload.sub });
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    const onFile = String(user.personal_email ?? '').trim().toLowerCase();

    if (supplied && (supplied.length > 254 || !EMAIL_RE.test(supplied))) {
      throw badRequest('Enter a valid email address');
    }
    const target = supplied || onFile;
    if (!target) throw badRequest('Enter your personal email address');
    if (supplied) {
      const clash = await query(
        `SELECT 1 FROM users WHERE tenant_id = $1 AND lower(personal_email) = $2 AND id <> $3`,
        [tenantId, supplied, userId],
        { tenantId, userId }
      );
      if (clash.rows.length > 0) throw badRequest('That email address is already in use');
    }

    const issued = await issueEmailCode({
      tenantId,
      userId,
      email: target,
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      purpose: supplied && supplied !== onFile ? 'ENROLL' : 'LOGIN',
      ip: ipOf(req),
      userAgent: req.ctx.userAgent,
    });
    if (!issued.ok) {
      throw new ApiError(503, 'EMAIL_DELIVERY_FAILED', 'We could not send your code. Please try again shortly.');
    }
    res.json({
      ok: true,
      method: 'email',
      maskedEmail: maskEmail(target),
      alreadySent: Boolean(issued.alreadySent),
      expiresInMinutes: issued.expiresInMinutes ?? config.mfa.emailCodeTtlMinutes,
      resendAfterSeconds: issued.resendAfterSeconds ?? config.mfa.emailCodeResendSeconds,
    });
  })
);

/**
 * MFA-002: finish enrollment. The verified code row carries the address the
 * code was delivered to, which becomes the account's personal email.
 */
authRouter.post(
  '/mfa/email/confirm-enroll',
  mfaLimiter,
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
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid], { tenantId: payload.tid, userId: payload.sub });
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);

    const verified = await verifyEmailCode({ tenantId, userId, code });
    if (!verified.ok) throw badRequest('Invalid or expired code');
    const email = String(verified.email ?? '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Invalid or expired code');
    const clash = await query(
      `SELECT 1 FROM users WHERE tenant_id = $1 AND lower(personal_email) = $2 AND id <> $3`,
      [tenantId, email, userId],
      { tenantId, userId }
    );
    if (clash.rows.length > 0) throw badRequest('That email address is already in use');

    await query(
      `UPDATE users SET personal_email = $1, personal_email_verified_at = now(),
              mfa_enabled = true, mfa_method = 'EMAIL' WHERE id = $2`,
      [email, userId],
      { tenantId, userId }
    );
    await query(
      `INSERT INTO mfa_methods (tenant_id, user_id, method, verified_at, is_active)
       VALUES ($1,$2,'EMAIL',now(),true)
       ON CONFLICT (user_id, method) DO UPDATE SET verified_at = now(), is_active = true, updated_at = now()`,
      [tenantId, userId],
      { tenantId, userId }
    );
    await clearEmailCodes(tenantId, userId);
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, {
        action: 'mfa_enrolled_email',
        resource: 'auth',
        recordId: userId,
        newValues: { mfa_enabled: true, mfa_method: 'EMAIL' },
        metadata: { purpose: verified.purpose ?? 'ENROLL' },
      });
    }, { tenantId, userId });

    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    const freshRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId], { tenantId, userId });
    res.json({
      accessToken,
      refreshToken,
      mfaEnabled: true,
      method: 'email',
      maskedEmail: maskEmail(email),
      user: redactUser(freshRes.rows[0] as Record<string, unknown>),
    });
  })
);

// ---------------------------------------------------------------- MFA enrollment (login token flow)
authRouter.post(
  '/mfa/enroll-start',
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.loginToken ?? '');
    if (!token) throw badRequest('loginToken is required');
    let payload;
    try {
      payload = verifyLoginToken(token);
    } catch {
      throw unauthorized('Invalid login token');
    }
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid], { tenantId: payload.tid, userId: payload.sub });
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    if (Boolean(user.mfa_enabled)) throw badRequest('MFA is already enabled');
    const secret = generateTotpSecret();
    await query(`UPDATE users SET mfa_secret=$1, mfa_method='TOTP' WHERE id=$2`, [secret, Number(user.id)], { tenantId: payload.tid, userId: Number(user.id) });
    res.json(await totpEnrollmentPayload(String(user.email), secret));
  })
);

authRouter.post(
  '/mfa/enroll-verify',
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.loginToken ?? '');
    const code = String(req.body?.code ?? '').trim();
    const secret = String(req.body?.secret ?? '');
    if (!token || !code) throw badRequest('loginToken and code are required');
    let payload;
    try {
      payload = verifyLoginToken(token);
    } catch {
      throw unauthorized('Invalid login token');
    }
    const userRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [payload.sub, payload.tid], { tenantId: payload.tid, userId: payload.sub });
    const user = userRes.rows[0] as Record<string, unknown> | undefined;
    if (!user) throw unauthorized('User not found');
    if (Boolean(user.mfa_enabled)) throw badRequest('MFA is already enabled');
    const stored = secret || String(user.mfa_secret ?? '');
    if (!stored || !verifyTotp(stored, code)) throw badRequest('Invalid MFA code');
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    await query(`UPDATE users SET mfa_enabled=true, mfa_secret=$1 WHERE id=$2`, [stored, userId], { tenantId, userId });
    const { sid, refreshToken } = await createSession(userId, tenantId, ipOf(req), req.ctx.userAgent, req.ctx.device, true);
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(client, { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, { action: 'mfa_enrolled', resource: 'auth', recordId: userId });
    }, { tenantId, userId });
    const freshRes = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId], { tenantId, userId });
    res.json({ accessToken, refreshToken, user: redactUser(freshRes.rows[0] as Record<string, unknown>) });
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
    res.json(await totpEnrollmentPayload(user.email, secret));
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

// ---------------------------------------------------------------- MFA status & personal email (authenticated)
authRouter.get(
  '/mfa/status',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const pending = await query(
      `SELECT email FROM mfa_email_codes
        WHERE user_id = $1 AND purpose = 'CHANGE_EMAIL' AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [user.id],
      { tenantId: user.tenant_id, userId: user.id }
    );
    const personal = String(user.personal_email ?? '').trim() || null;
    res.json({
      mfaEnabled: Boolean(user.mfa_enabled),
      method: String(user.mfa_method ?? '').trim() || null,
      personalEmail: personal,
      maskedEmail: personal ? maskEmail(personal) : null,
      verifiedAt: user.personal_email_verified_at ?? null,
      pendingEmail: pending.rows[0] ? String((pending.rows[0] as { email: string }).email) : null,
    });
  })
);

/** Set or change the personal address; the code always goes to the NEW address. */
authRouter.post(
  '/mfa/personal-email',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Enter a valid email address');
    const clash = await query(
      `SELECT 1 FROM users WHERE tenant_id = $1 AND lower(personal_email) = $2 AND id <> $3`,
      [user.tenant_id, email, user.id],
      { tenantId: user.tenant_id, userId: user.id }
    );
    if (clash.rows.length > 0) throw badRequest('That email address is already in use');
    const issued = await issueEmailCode({
      tenantId: user.tenant_id,
      userId: user.id,
      email,
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      purpose: 'CHANGE_EMAIL',
      ip: ipOf(req),
      userAgent: req.ctx.userAgent,
    });
    if (!issued.ok) {
      throw new ApiError(503, 'EMAIL_DELIVERY_FAILED', 'We could not send your code. Please try again shortly.');
    }
    res.json({
      ok: true,
      maskedEmail: maskEmail(email),
      alreadySent: Boolean(issued.alreadySent),
      expiresInMinutes: issued.expiresInMinutes ?? config.mfa.emailCodeTtlMinutes,
      resendAfterSeconds: issued.resendAfterSeconds ?? config.mfa.emailCodeResendSeconds,
    });
  })
);

authRouter.post(
  '/mfa/personal-email/confirm',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    const code = String(req.body?.code ?? '').trim();
    if (!code) throw badRequest('Verification code is required');
    const verified = await verifyEmailCode({ tenantId: user.tenant_id, userId: user.id, code });
    if (!verified.ok || String(verified.purpose) !== 'CHANGE_EMAIL') throw badRequest('Invalid or expired code');
    const email = String(verified.email ?? '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Invalid or expired code');
    const previous = String(user.personal_email ?? '').trim() || null;
    await query(
      `UPDATE users SET personal_email = $1, personal_email_verified_at = now(),
              mfa_enabled = true, mfa_method = 'EMAIL' WHERE id = $2`,
      [email, user.id],
      { tenantId: user.tenant_id, userId: user.id }
    );
    await query(
      `INSERT INTO mfa_methods (tenant_id, user_id, method, verified_at, is_active)
       VALUES ($1,$2,'EMAIL',now(),true)
       ON CONFLICT (user_id, method) DO UPDATE SET verified_at = now(), is_active = true, updated_at = now()`,
      [user.tenant_id, user.id],
      { tenantId: user.tenant_id, userId: user.id }
    );
    await clearEmailCodes(user.tenant_id, user.id);
    await tx(async (client) => {
      await logAudit(client, { tenantId: user.tenant_id, userId: user.id, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, {
        action: 'mfa_personal_email_changed',
        resource: 'users',
        recordId: user.id,
        oldValues: { personal_email: previous },
        newValues: { personal_email: email },
      });
    }, { tenantId: user.tenant_id, userId: user.id });
    res.json({ ok: true, personalEmail: email, maskedEmail: maskEmail(email), mfaEnabled: true, method: 'email' });
  })
);

/** Turn the emailed-code factor off. The address is kept so it can be re-enabled. */
authRouter.post(
  '/mfa/disable',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.auth!;
    await query(`UPDATE users SET mfa_enabled = false WHERE id = $1`, [user.id], { tenantId: user.tenant_id, userId: user.id });
    await query(`UPDATE mfa_methods SET is_active = false WHERE user_id = $1`, [user.id], { tenantId: user.tenant_id, userId: user.id });
    await clearEmailCodes(user.tenant_id, user.id);
    await tx(async (client) => {
      await logAudit(client, { tenantId: user.tenant_id, userId: user.id, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device }, {
        action: 'mfa_disabled',
        resource: 'users',
        recordId: user.id,
        newValues: { mfa_enabled: false },
      });
    }, { tenantId: user.tenant_id, userId: user.id });
    res.json({ ok: true, mfaEnabled: false });
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
      await query('SELECT auth_revoke_session_by_token_hash($1)', [hashToken(refresh)]);
    } else if (bearer) {
      try {
        const { verifyAccessToken } = await import('../auth.js');
        const payload = verifyAccessToken(bearer);
        if (payload.sid) await query('SELECT auth_revoke_session_by_id($1)', [payload.sid]);
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
    if (next.length < 12) throw badRequest('New password must be at least 12 characters');
    if (next === current) throw badRequest('New password must be different from the current password');
    if (/changeme/i.test(next) || next === 'ChangeMe!2026') {
      throw badRequest('Choose a password that is not the seeded default');
    }
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      throw badRequest('New password must include letters and numbers');
    }
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
