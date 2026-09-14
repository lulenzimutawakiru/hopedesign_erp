import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { hashToken, signAccessToken, signLoginToken, verifyLoginToken, verifyPassword, generateTotpSecret, totpEnrollmentPayload, verifyTotp, redactUser, hashPassword, maskEmail } from '../auth.js';
import { detach, query, tx } from '../db.js';
import { authenticate, loadAuthUser } from '../middleware/auth.js';
import { asyncHandler, badRequest, unauthorized } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { loginLimiter, mfaLimiter, inviteLimiter, passwordResetLimiter } from '../middleware/rateLimits.js';
import { ApiError } from '../utils.js';
import { config } from '../config.js';
import { issueEmailCode, verifyEmailCode, clearEmailCodes, EMAIL_RE } from '../services/mfaEmail.js';
import { sendEmail } from '../services/bird.js';
import { createTicket } from '../services/serviceDesk.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
/** Self-service reset links stay valid for one hour. */
const RESET_TOKEN_TTL_MINUTES = 60;

function ipOf(req: import('express').Request): string {
  return req.ctx.ip || '';
}

/**
 * AUTH-003: identity comparison is forgiving. Case is ignored and spaces, dots,
 * underscores and hyphens are equivalent separators, so "Nyirinkindi Annonciata",
 * "nyirinkindi.annonciata" and "nyirinkindi_annonciata" all reach one account.
 * `auth_resolve_user_by_identifier` applies the same rule in the database.
 */
function normalizeIdentifier(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * AUTH-003: a rejected sign-in previously left no server-side trace, which made
 * "my password is right but I cannot get in" impossible to diagnose in
 * production. The identifier is hashed so the log never carries an account
 * name, and the password is never read here.
 */
function logLoginFailure(
  reason: string,
  identifier: string,
  req: import('express').Request,
  extra?: Record<string, unknown>
): void {
  const tag = createHash('sha256').update(identifier).digest('hex').slice(0, 12);
  console.warn(
    `[auth] login rejected reason=${reason} identifier=${tag} ip=${ipOf(req) || '-'}` +
      (extra ? ' ' + JSON.stringify(extra) : '')
  );
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

/**
 * True when a verified `mfa_methods` row records an authenticator app that was
 * actually paired with this account.
 */
async function totpFactorPaired(userId: number, tenantId: number): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM mfa_methods
      WHERE user_id = $1 AND method = 'TOTP' AND verified_at IS NOT NULL AND is_active
      LIMIT 1`,
    [userId],
    { tenantId, userId }
  );
  return res.rows.length > 0;
}

/**
 * AUTH-004: the second factor described by a user row is only usable when its
 * holder can actually satisfy it.
 *
 * A TOTP secret is written when enrolment *starts*, so an abandoned attempt
 * leaves a secret behind, and treating that secret as a live factor strands the
 * holder behind a code they have never been able to generate - the account
 * looks protected while being impossible to sign in to. A code can only be
 * produced once the authenticator has been paired, which is what a verified
 * `mfa_methods` row records. Email needs a delivered address.
 *
 * Returns the factor that can be challenged, or null when the account has none
 * and must be offered enrolment instead of a challenge it cannot pass.
 */
async function secondFactorUsable(user: Record<string, unknown>): Promise<'email' | 'totp' | null> {
  if (!Boolean(user.mfa_enabled)) return null;
  const method = String(user.mfa_method ?? '').toUpperCase();
  if (method === 'EMAIL' && String(user.personal_email ?? '').trim().length > 0) return 'email';
  if (String(user.mfa_secret ?? '').trim().length > 0 && (await totpFactorPaired(Number(user.id), Number(user.tenant_id)))) {
    return 'totp';
  }
  return null;
}

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const identifier = normalizeIdentifier(req.body?.identifier);
    const password = String(req.body?.password ?? '');
    const mfaCode = req.body?.mfaCode ? String(req.body.mfaCode).trim() : null;
    if (!identifier || !password) {
      logLoginFailure('missing_fields', identifier || '(blank)', req, { hasPassword: Boolean(password) });
      throw badRequest('Identifier and password are required');
    }

    const user = await userByLogin(identifier);
    if (!user) {
      await recordAttempt(identifier, ipOf(req), false);
      logLoginFailure('unknown_identifier', identifier, req);
      throw unauthorized('Invalid credentials');
    }
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);

    if (String(user.status) === 'LOCKED') {
      const lockedUntil = user.locked_until ? new Date(String(user.locked_until)) : null;
      if (lockedUntil && lockedUntil.getTime() > Date.now()) {
        logLoginFailure('account_locked', identifier, req, { lockedUntil: String(user.locked_until) });
        throw new ApiError(423, 'ACCOUNT_LOCKED', 'Account is temporarily locked. Try again later.');
      }
      await query(`UPDATE users SET status='ACTIVE', failed_attempts=0, locked_until=NULL WHERE id=$1`, [userId], { tenantId, userId });
    }
    if (!['ACTIVE', 'PENDING'].includes(String(user.status))) {
      logLoginFailure('status_not_active', identifier, req, { status: String(user.status) });
      throw unauthorized('Account is not active');
    }

    const ok = await verifyPassword(password, String(user.password_hash));
    if (!ok) {
      const attempts = Number(user.failed_attempts ?? 0) + 1;
      if (attempts >= LOCKOUT_THRESHOLD) {
        await query(
          `UPDATE users SET failed_attempts=$2, locked_until=now() + ($3 || ' minutes')::interval, status='LOCKED' WHERE id=$1`,
          [userId, attempts, LOCKOUT_MINUTES], { tenantId, userId }
        );
        await recordAttempt(identifier, ipOf(req), false);
        logLoginFailure('bad_password_lockout', identifier, req, { attempts });
        throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Account locked.');
      }
      await query(`UPDATE users SET failed_attempts=$2 WHERE id=$1`, [userId, attempts], { tenantId, userId });
      await recordAttempt(identifier, ipOf(req), false);
      logLoginFailure('bad_password', identifier, req, { attempts });
      throw unauthorized('Invalid credentials');
    }

    await query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [userId], { tenantId, userId });
    await recordAttempt(identifier, ipOf(req), true);

    // AUTH-001 / MFA-002: a second factor must be satisfied before a session is
    // issued. `mfa_method` selects the challenge:
    //   EMAIL -> a six-digit code mailed to the holder's personal address
    //   TOTP  -> the authenticator-app code, retained for already-paired users
    // Accounts with no usable second factor that hold privileged permissions are
    // routed to enrollment instead of straight into a session.
    const personalEmail = String(user.personal_email ?? '').trim();
    const mfaMethod = String(user.mfa_method ?? '').toUpperCase();
    const emailMfaReady = Boolean(user.mfa_enabled) && mfaMethod === 'EMAIL' && personalEmail.length > 0;
    // AUTH-004: `mfa_secret` alone is not proof of a usable factor, so a stale
    // or abandoned enrolment falls through to the enrollment branch below.
    const totpMfaReady = (await secondFactorUsable(user)) === 'totp';

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
            logLoginFailure('mfa_email_delivery_failed', identifier, req, { error: issued.error ?? null });
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
          // A TOTP holder who has lost the authenticator is not stranded: the
          // client offers email enrollment as an alternative factor, which
          // still requires control of a mailbox on top of the password.
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
    const privileged = await userHoldsPrivilegedPermission(userId, tenantId);
    if (Boolean(user.mfa_enabled) || privileged) {
      logLoginFailure('mfa_enrollment_required', identifier, req, {
        mfa_enabled: Boolean(user.mfa_enabled),
        method: mfaMethod || null,
        privileged,
      });
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
// ---------------------------------------------------------------- self-service password reset
/**
 * AUTH-003: start a self-service reset.
 *
 * The acknowledgement is byte-for-byte identical for a known identifier, an
 * unknown one and a blank one, and it never reports whether mail went out, so
 * the endpoint cannot be turned into an account-discovery oracle. A resolvable
 * request does two further things: it raises a Service Desk ticket, because
 * recoverable sign-in trouble is exactly what the desk exists for, and it mails
 * a single-use link to the address already on the account.
 */
authRouter.post(
  '/password/forgot',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const identifier = normalizeIdentifier(req.body?.identifier);
    const acknowledged = { ok: true, message: 'If that account exists, we have emailed a reset link.' };
    if (!identifier) return res.json(acknowledged);

    const user = await userByLogin(identifier);
    if (!user) return res.json(acknowledged);

    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    // LOCKED is admitted deliberately: an employee locked out by failed
    // attempts is the main caller here. DISABLED and SUSPENDED accounts stay
    // unreachable - a reset must never be a route back into a revoked account.
    if (!['ACTIVE', 'PENDING', 'LOCKED'].includes(String(user.status).toUpperCase())) {
      return res.json(acknowledged);
    }

    const companyId = user.company_id === null || user.company_id === undefined ? null : Number(user.company_id);
    const branchId = user.branch_id === null || user.branch_id === undefined ? null : Number(user.branch_id);
    const ip = ipOf(req);
    const userAgent = req.ctx.userAgent;
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    // A second request retires every outstanding link, so an older intercepted
    // link cannot be replayed after the holder asks again.
    await query('SELECT auth_supersede_reset_tokens($1)', [userId]);
    const created = await query('SELECT * FROM auth_reset_create($1,$2,$3,$4,$5,$6,$7,$8)', [
      tenantId,
      userId,
      hashToken(raw),
      expiresAt,
      companyId,
      branchId,
      ip || null,
      userAgent || null,
    ]);
    const tokenId = created.rows[0] ? Number((created.rows[0] as Record<string, unknown>).id) : null;

    const to = String(user.email ?? '').trim() || String(user.personal_email ?? '').trim();
    let delivered = false;
    if (to) {
      const link = `${config.webPublicUrl}/#/reset?token=${encodeURIComponent(raw)}`;
      const greeting = String([user.first_name, user.last_name].filter(Boolean).join(' ')).trim();
      const text = [
        greeting ? `Hello ${greeting},` : 'Hello,',
        '',
        'We received a request to reset the password for your HOPE DESIGN account.',
        '',
        `Choose a new password here. The link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes:`,
        link,
        '',
        'A Service Desk ticket has been logged for this request, so IT can follow up if you are still stuck.',
        '',
        'If you did not ask for this you can ignore this email - your current password still works.',
        '',
        'HOPE DESIGN GROUP LTD',
      ].join('\n');
      const result = await sendEmail({
        to: [to],
        subject: 'Reset your HOPE DESIGN password',
        text,
        preheader: `Your reset link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
        button: { label: 'Choose a new password', url: link },
      });
      delivered = result.ok;
      if (!result.ok) {
        console.error(`[auth] password reset mail failed user=${userId} error=${result.error ?? 'unknown'}`);
      }
    }

    // The ticket is a courtesy, never a dependency: the link is already minted
    // and on its way, so a desk failure is logged and the caller still gets the
    // same calm acknowledgement.
    let ticketId: number | null = null;
    if (companyId && tokenId) {
      try {
        ticketId = await detach(
          async (client, ctx) => {
            const cat = await client.query<{ category_id: number; subcategory_id: number }>(
              `SELECT c.id AS category_id, sc.id AS subcategory_id
                 FROM service_subcategories sc
                 JOIN service_categories c ON c.id = sc.category_id
                WHERE sc.tenant_id = $1 AND sc.company_id = $2 AND sc.is_active AND c.is_active
                  AND sc.code IN ('PASSWORD', 'USER_ACCOUNT', 'LOGIN')
                ORDER BY CASE sc.code WHEN 'PASSWORD' THEN 1 WHEN 'USER_ACCOUNT' THEN 2 ELSE 3 END
                LIMIT 1`,
              [tenantId, companyId]
            );
            if (cat.rows.length === 0) return null;
            const ticket = (await createTicket(
              client,
              ctx,
              {
                categoryId: Number(cat.rows[0].category_id),
                subcategoryId: Number(cat.rows[0].subcategory_id),
                ticketType: 'SERVICE_REQUEST',
                subject: `Password reset requested - ${to || 'account on file'}`.slice(0, 200),
                description:
                  'A self-service password reset was requested from the sign-in screen. ' +
                  'A single-use reset link was emailed to the address on the account. ' +
                  'If the employee reports that the link never arrived, verify the mailbox and reset from the desk.',
                impact: 'INDIVIDUAL',
                urgency: 'MEDIUM',
                preferredContact: 'EMAIL',
                source: 'SYSTEM',
              },
              { selfService: true }
            )) as unknown as Record<string, unknown>;
            const id = Number(ticket.id);
            await client.query('SELECT auth_reset_attach_ticket($1,$2)', [tokenId, id]);
            return id;
          },
          { tenantId, companyId, branchId, userId, ip, userAgent }
        );
      } catch (err) {
        console.error(`[auth] password reset auto-ticket failed user=${userId}`, err);
      }
    }

    await tx(async (client) => {
      await logAudit(
        client,
        { tenantId, userId, ip, userAgent, device: req.ctx.device },
        {
          action: 'password_reset_requested',
          resource: 'users',
          recordId: userId,
          metadata: { ticket_id: ticketId, delivered },
        }
      );
    }, { tenantId, userId });

    return res.json(acknowledged);
  })
);

/**
 * AUTH-003: complete a self-service reset.
 *
 * The token is claimed with a single conditional UPDATE, so two concurrent
 * submissions cannot both set a password. A successful reset also clears any
 * lockout, ends every other session on the account, and signs the holder in, so
 * recovery is one step rather than three.
 */
authRouter.post(
  '/password/reset',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!token) throw badRequest('This reset link is missing its token. Request a new one.');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');

    const expired = unauthorized('This reset link is invalid or has expired. Request a new one.');
    const hash = hashToken(token);
    const found = (await query('SELECT * FROM auth_reset_token_by_hash($1)', [hash])).rows[0] as
      | Record<string, unknown>
      | undefined;
    if (!found || found.used_at) throw expired;
    if (new Date(String(found.expires_at)).getTime() <= Date.now()) throw expired;

    const claimed = (
      await query('SELECT * FROM auth_reset_consume($1,$2,$3)', [hash, ipOf(req) || null, req.ctx.userAgent || null])
    ).rows[0] as Record<string, unknown> | undefined;
    if (!claimed) throw expired;

    const userId = Number(claimed.user_id);
    const tenantId = Number(claimed.tenant_id);
    const user = (
      await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId], { tenantId, userId })
    ).rows[0] as Record<string, unknown> | undefined;
    if (!user) throw expired;

    const currentStatus = String(user.status).toUpperCase();
    if (!['ACTIVE', 'PENDING', 'LOCKED'].includes(currentStatus)) {
      throw unauthorized('This account is not active. Please contact the Service Desk.');
    }

    const passwordHash = await hashPassword(password);
    // LOCKED and PENDING become ACTIVE; a status that is already usable is left
    // exactly as it was.
    await query(
      `UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=false,
              failed_attempts=0, locked_until=NULL,
              status = CASE WHEN status IN ('LOCKED', 'PENDING') THEN 'ACTIVE' ELSE status END
        WHERE id=$2`,
      [passwordHash, userId],
      { tenantId, userId }
    );
    await query(
      `INSERT INTO user_status_history (tenant_id, user_id, from_status, to_status, reason, changed_by)
       VALUES ($1,$2,$3,'ACTIVE','Password reset completed',NULL)`,
      [tenantId, userId, currentStatus],
      { tenantId, userId }
    );
    await query('SELECT auth_revoke_all_sessions($1)', [userId]);

    const fresh = (
      await query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId], { tenantId, userId })
    ).rows[0] as Record<string, unknown>;
    const { sid, refreshToken } = await createSession(
      userId,
      tenantId,
      ipOf(req),
      req.ctx.userAgent,
      req.ctx.device,
      true
    );
    const accessToken = signAccessToken({ sub: userId, tid: tenantId, sid, type: 'access' });
    await tx(async (client) => {
      await logAudit(
        client,
        { tenantId, userId, ip: ipOf(req), userAgent: req.ctx.userAgent, device: req.ctx.device },
        {
          action: 'password_reset_completed',
          resource: 'users',
          recordId: userId,
          metadata: { previous_status: currentStatus, ticket_id: claimed.ticket_id ?? null },
        }
      );
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
      // AUTH-004: never loop the holder on a code their account cannot produce.
      if (!(await totpFactorPaired(userId, tenantId))) {
        throw badRequest('No authenticator app is paired with this account. Start the sign-in again to set one up.');
      }
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
    // AUTH-004: a factor that cannot be satisfied is repaired here rather than
    // blocking sign-in, so an abandoned enrolment is recoverable self-service.
    if ((await secondFactorUsable(user)) !== null) throw badRequest('Two-step verification is already set up for this account');
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
    if ((await secondFactorUsable(user)) !== null) throw badRequest('Two-step verification is already set up for this account');
    const stored = secret || String(user.mfa_secret ?? '');
    if (!stored || !verifyTotp(stored, code)) throw badRequest('Invalid MFA code');
    const userId = Number(user.id);
    const tenantId = Number(user.tenant_id);
    await query(`UPDATE users SET mfa_enabled=true, mfa_secret=$1, mfa_method='TOTP' WHERE id=$2`, [stored, userId], { tenantId, userId });
    await query(
      `INSERT INTO mfa_methods (tenant_id, user_id, method, verified_at, is_active)
       VALUES ($1,$2,'TOTP',now(),true)
       ON CONFLICT (user_id, method) DO UPDATE SET verified_at = now(), is_active = true, updated_at = now()`,
      [tenantId, userId],
      { tenantId, userId }
    );
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
    await query(`UPDATE users SET mfa_enabled=true, mfa_secret=$1, mfa_method='TOTP' WHERE id=$2`, [s, user.id], { tenantId: user.tenant_id, userId: user.id });
    await query(
      `INSERT INTO mfa_methods (tenant_id, user_id, method, verified_at, is_active)
       VALUES ($1,$2,'TOTP',now(),true)
       ON CONFLICT (user_id, method) DO UPDATE SET verified_at = now(), is_active = true, updated_at = now()`,
      [user.tenant_id, user.id],
      { tenantId: user.tenant_id, userId: user.id }
    );
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
    // AUTH-003: one rule for every password entry point. Invitation acceptance
    // and self-service reset both accept eight characters, so requiring twelve
    // here only locked people into a length they could not reproduce elsewhere.
    if (next.length < 8) throw badRequest('New password must be at least 8 characters');
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
