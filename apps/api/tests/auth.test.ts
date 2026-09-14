import { describe, it, expect, vi } from 'vitest';
import { api, PASSWORD, auth, loginAs, db, deleteEmployees } from './helpers.js';
import { issueEmailCode, verifyEmailCode } from '../src/services/mfaEmail.js';
import { hashToken } from '../src/auth.js';
import { authenticator } from 'otplib';

// A reset link only ever leaves the building by email, so the sender is captured
// here. That lets the suite start a reset through the real public endpoint and
// then drive the exact link it produced, instead of reaching into the database
// for a token the employee is supposed to receive.
const mailbox = vi.hoisted(
  () => [] as Array<{ to: string[]; subject: string; text?: string; button?: { label: string; url: string } | null }>
);
vi.mock('../src/services/bird.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/bird.js')>();
  return {
    ...actual,
    sendEmail: async (input: (typeof mailbox)[number]) => {
      mailbox.push(input);
      return { ok: true, provider: 'mock', providerMessageId: 'mock-reset' };
    },
  };
});

describe('Authentication', () => {
  it('GET /api/health reports service ok', async () => {
    const res = await api.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('hopedesign-erp-api');
  });

  it('logs in as admin (MFA step) and completes to a session token', async () => {
    // Privileged users must complete MFA before a session is issued, so the
    // first step of login only returns an MFA challenge.
    const res = await api.post('/api/auth/login').send({ identifier: 'admin', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(typeof res.body.loginToken).toBe('string');
    if (res.body.enrollmentRequired) {
      const es = await api.post('/api/auth/mfa/enroll-start').send({ loginToken: res.body.loginToken });
      expect(es.status).toBe(200);
      expect(String(es.body.secret || '')).toBeTruthy();
      expect(String(es.body.qrDataUrl || '')).toMatch(/^data:image\/png;base64,/);
    }
    const { token } = await loginAs('admin');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
  });

  it('rejects a wrong password with 401 UNAUTHORIZED', async () => {
    const res = await api.post('/api/auth/login').send({ identifier: 'admin', password: 'definitely-not-the-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/auth/me requires authentication', async () => {
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/auth/me returns the current user and unread count', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/auth/me').set(auth(token));
    expect(res.status).toBe(200);
    expect(Number(res.body.user.id)).toBe(1);
    expect(typeof res.body.unreadNotifications).toBe('number');
  });

  it('records a successful login in the audit log', async () => {
    const count = async () => {
      const r = await db(
        `SELECT count(*)::int AS n FROM audit_logs WHERE resource='auth' AND action IN ('login','login_mfa') AND record_id=1`
      );
      return Number(r.rows[0].n);
    };
    const before = await count();
    await loginAs('admin');
    const after = await count();
    // Other test files log in concurrently (same record_id=1), so the count can
    // grow by more than one; at least one new row must be present.
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });
});

describe('Administration users', () => {
  it('lists tenant users without a status filter and still returns them when filtered to ACTIVE', async () => {
    const { token } = await loginAs('admin');
    const all = await api.get('/api/admin/users?pageSize=50').set(auth(token));
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.data.data)).toBe(true);
    expect(all.body.data.data.length).toBeGreaterThan(0);
    expect(Number(all.body.data.pagination.total)).toBeGreaterThanOrEqual(all.body.data.data.length);
    const searched = await api.get('/api/admin/users?search=admin&pageSize=50').set(auth(token));
    expect(searched.status).toBe(200);
    const adminRow = searched.body.data.data.find((u: { username?: string }) => u.username === 'admin');
    expect(adminRow).toBeTruthy();

    const active = await api.get('/api/admin/users?status=ACTIVE&pageSize=50').set(auth(token));
    expect(active.status).toBe(200);
    expect(active.body.data.data.length).toBeGreaterThan(0);
    expect(active.body.data.data.every((u: { status: string }) => u.status === 'ACTIVE')).toBe(true);

    const dash = await api.get('/api/admin/dashboard').set(auth(token));
    expect(dash.status).toBe(200);
    expect(Number(dash.body.data.users.total)).toBeGreaterThan(0);

    const dbHealth = await api.get('/api/admin/database/health').set(auth(token));
    expect(dbHealth.status).toBe(200);
  });

  it('links a user account to an employee file and unlinks it', async () => {
    const { token } = await loginAs('admin');
    const stamp = Date.now();
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Link',
      lastName: `Probe${stamp}`,
      position: 'Clerk',
      email: `link.probe.${stamp}@hopedesign.test`,
      baseSalary: 100000,
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const created = await api.post('/api/admin/users').set(auth(token)).send({
      first_name: 'Link',
      last_name: `Login${stamp}`,
      email: `link.login.${stamp}@hopedesign.test`,
      username: `linklogin${stamp}`,
    });
    expect(created.status).toBe(200);
    const userId = Number(created.body.data.user.id);

    const linked = await api.post(`/api/admin/users/${userId}/link-employee`).set(auth(token)).send({ employeeId });
    expect(linked.status).toBe(200);
    expect(Number(linked.body.data.employeeId)).toBe(employeeId);

    const detail = await api.get(`/api/admin/users/${userId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(Number(detail.body.data.employee.id)).toBe(employeeId);

    const hr = await api.get(`/api/ops/hr/employees/${employeeId}`).set(auth(token));
    expect(hr.status).toBe(200);
    expect(Number(hr.body.data.account.id)).toBe(userId);

    const other = await api.post('/api/admin/users').set(auth(token)).send({
      first_name: 'Other',
      last_name: `Login${stamp}`,
      email: `link.other.${stamp}@hopedesign.test`,
      username: `linkother${stamp}`,
    });
    expect(other.status).toBe(200);
    const clash = await api.post(`/api/admin/users/${other.body.data.user.id}/link-employee`).set(auth(token)).send({ employeeId });
    expect(clash.status).toBe(409);

    const unlinked = await api.post(`/api/admin/users/${userId}/unlink-employee`).set(auth(token)).send({});
    expect(unlinked.status).toBe(200);
    const after = await api.get(`/api/admin/users/${userId}`).set(auth(token));
    expect(after.body.data.employee).toBeNull();

    const sharedEmail = `link.auto.${stamp}@hopedesign.test`;
    const autoUser = await api.post('/api/admin/users').set(auth(token)).send({
      first_name: 'Auto',
      last_name: `Login${stamp}`,
      email: sharedEmail,
      username: `linkauto${stamp}`,
    });
    expect(autoUser.status).toBe(200);
    const autoEmp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Auto',
      lastName: `Probe${stamp}`,
      position: 'Clerk',
      email: sharedEmail,
      baseSalary: 100000,
    });
    expect(autoEmp.status).toBe(200);
    expect(Number(autoEmp.body.data.userId)).toBe(Number(autoUser.body.data.user.id));

    await deleteEmployees([employeeId, Number(autoEmp.body.data.employeeId)]);
  });
});

describe('MFA email one-time codes', () => {
  const stamp = Date.now();

  /** Throwaway account in tenant 2 so the mail path never touches seeded users. */
  async function createMailUser() {
    const { hashPassword } = await import('../src/auth.js');
    const passwordHash = await hashPassword(PASSWORD);
    const username = `mail.path.${stamp}.${Math.random().toString(36).slice(2, 8)}`;
    const email = `${username}@hopedesign.test`;
    const ins = await db(
      `INSERT INTO users (tenant_id, company_id, email, username, password_hash, first_name, last_name)
       VALUES (2, 2, $1, $2, $3, 'Mail', 'Path') RETURNING id`,
      [email, username, passwordHash]
    );
    return { userId: Number(ins.rows[0].id), email };
  }

  async function dropMailUser(userId: number) {
    await db(`DELETE FROM mfa_email_codes WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  it('issues a single-use code when delivery succeeds', async () => {
    const { userId, email } = await createMailUser();
    try {
      let sent = '';
      const issued = await issueEmailCode({
        tenantId: 2,
        userId,
        email,
        name: 'Mail Path',
        purpose: 'LOGIN',
        send: async (d) => {
          sent = d.code;
          return { ok: true };
        },
      });
      expect(issued.ok).toBe(true);
      expect(sent).toMatch(/^\d{6}$/);

      const verified = await verifyEmailCode({ tenantId: 2, userId, code: sent });
      expect(verified.ok).toBe(true);
      expect(verified.purpose).toBe('LOGIN');

      // One-time: the same code cannot be replayed.
      const replay = await verifyEmailCode({ tenantId: 2, userId, code: sent });
      expect(replay.ok).toBe(false);
      expect(replay.error).toBe('no_active_code');
    } finally {
      await dropMailUser(userId);
    }
  });

  it('fails closed and burns the code when mail delivery fails', async () => {
    const { userId, email } = await createMailUser();
    try {
      let sent = '';
      const failed = await issueEmailCode({
        tenantId: 2,
        userId,
        email,
        name: 'Mail Path',
        purpose: 'LOGIN',
        send: async (d) => {
          sent = d.code;
          return { ok: false, error: 'Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing)' };
        },
      });
      expect(failed.ok).toBe(false);
      expect(String(failed.error)).toMatch(/not configured/i);
      // The plaintext code must never reach the caller on failure.
      expect(failed.code).toBeUndefined();

      // Nothing usable survives: even the exact right code is rejected, so an
      // undelivered code can never be guessed into a session.
      const open = await db(
        `SELECT count(*)::int AS n FROM mfa_email_codes WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId]
      );
      expect(Number(open.rows[0].n)).toBe(0);
      const verified = await verifyEmailCode({ tenantId: 2, userId, code: sent });
      expect(verified.ok).toBe(false);
      expect(verified.error).toBe('no_active_code');
    } finally {
      await dropMailUser(userId);
    }
  });
});

describe('Self-service password reset', () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** Throwaway account in tenant 2, so the reset path never touches seeded users. */
  async function createResetUser() {
    const { hashPassword } = await import('../src/auth.js');
    const username = `reset.${tag}`;
    const email = `${username}@hopedesign.test`;
    const ins = await db(
      `INSERT INTO users (tenant_id, company_id, branch_id, email, username, password_hash, first_name, last_name, status)
       VALUES (2, 2, 2, $1, $2, $3, 'Reset', 'Path', 'ACTIVE') RETURNING id`,
      [email, username, await hashPassword(PASSWORD)]
    );
    return { userId: Number(ins.rows[0].id), email, username };
  }

  /**
   * The auto-raised ticket holds a plain FK to the requester, so it is cleared
   * before the account; everything hanging off the ticket itself cascades.
   */
  async function dropResetUser(userId: number) {
    await db(`DELETE FROM service_tickets WHERE requester_user_id = $1`, [userId]);
    await db(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  /** Mint a token deterministically, for cases the email flow cannot set up. */
  async function plantToken(userId: number, raw: string, expiresIn = `30 minutes`) {
    await db(
      `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at, created_by, company_id, branch_id)
       VALUES (2, $1, $2, now() + $3::interval, $1, 2, 2)`,
      [userId, hashToken(raw), expiresIn]
    );
  }

  /** Pull the raw token out of a delivered link (or out of the plain-text body). */
  function tokenFrom(text: string): string {
    return decodeURIComponent((text.match(/token=([^&\s]+)/) ?? [])[1] ?? '');
  }

  it('answers a known, an unknown and a blank identifier identically', async () => {
    const { userId, email } = await createResetUser();
    try {
      const known = await api.post('/api/auth/password/forgot').send({ identifier: email });
      const unknown = await api.post('/api/auth/password/forgot').send({ identifier: `nobody.${tag}@hopedesign.test` });
      const blank = await api.post('/api/auth/password/forgot').send({ identifier: '   ' });
      const expected = { ok: true, message: 'If that account exists, we have emailed a reset link.' };
      for (const res of [known, unknown, blank]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expected);
      }
      // Only the real account is actioned.
      const minted = await db(`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`, [userId]);
      expect(Number(minted.rows[0].n)).toBe(1);
    } finally {
      await dropResetUser(userId);
    }
  });

  it('mints a single-use link, emails it and raises a linked Service Desk ticket', async () => {
    mailbox.length = 0;
    const { userId, email } = await createResetUser();
    try {
      const res = await api.post('/api/auth/password/forgot').send({ identifier: email });
      expect(res.status).toBe(200);

      const row = (
        await db(
          `SELECT id, ticket_id, company_id, branch_id, requested_ip, expires_at
             FROM password_reset_tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
          [userId]
        )
      ).rows[0];
      expect(row).toBeTruthy();
      expect(Number(row.company_id)).toBe(2);
      const minutes = (new Date(row.expires_at).getTime() - Date.now()) / 60000;
      expect(minutes).toBeGreaterThan(50);
      expect(minutes).toBeLessThanOrEqual(61);

      // The desk sees the request: raised, numbered, routed to a queue and tied
      // back to the token so the agent can see recovery is already in flight.
      expect(row.ticket_id).toBeTruthy();
      const ticket = (
        await db(
          `SELECT ticket_number, requester_user_id, assigned_queue_id, status, priority
             FROM service_tickets WHERE id = $1`,
          [row.ticket_id]
        )
      ).rows[0];
      expect(Number(ticket.requester_user_id)).toBe(userId);
      expect(String(ticket.ticket_number)).toMatch(/^HDG-SD-\d{4}-\d{6}$/);
      expect(ticket.assigned_queue_id).toBeTruthy();

      const mail = mailbox.find((m) => (m.to ?? []).includes(email));
      expect(mail).toBeTruthy();
      expect(String(mail?.button?.url)).toContain('/#/reset?token=');
      expect(tokenFrom(String(mail?.button?.url))).toBeTruthy();
    } finally {
      await dropResetUser(userId);
    }
  });

  it('resets with the emailed link, signs the holder in and refuses a second use', async () => {
    mailbox.length = 0;
    const { userId, email, username } = await createResetUser();
    try {
      await api.post('/api/auth/password/forgot').send({ identifier: email });
      const mail = mailbox.find((m) => (m.to ?? []).includes(email));
      const raw = tokenFrom(`${mail?.button?.url ?? ''} ${mail?.text ?? ''}`);
      expect(raw).toBeTruthy();

      const next = 'ResetPath!2026';
      const done = await api.post('/api/auth/password/reset').send({ token: raw, password: next });
      expect(done.status).toBe(200);
      expect(typeof done.body.accessToken).toBe('string');
      expect(Number(done.body.user.id)).toBe(userId);

      // One shot: the same link can never set a second password.
      const reuse = await api.post('/api/auth/password/reset').send({ token: raw, password: 'Another!2026' });
      expect(reuse.status).toBe(401);

      const fresh = await api.post('/api/auth/login').send({ identifier: username, password: next });
      expect(fresh.status).toBe(200);
      expect(typeof fresh.body.accessToken).toBe('string');
      const old = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      expect(old.status).toBe(401);
    } finally {
      await dropResetUser(userId);
    }
  });

  it('clears a lockout, revokes earlier sessions and re-activates the account', async () => {
    const { userId, username } = await createResetUser();
    try {
      const first = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      expect(first.status).toBe(200);
      const older = first.body.accessToken as string;
      expect((await api.get('/api/auth/me').set(auth(older))).status).toBe(200);

      await db(
        `UPDATE users SET status='LOCKED', failed_attempts=5, locked_until=now() + interval '10 minutes' WHERE id=$1`,
        [userId]
      );
      // A locked account is still refused by the sign-in form.
      expect((await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD })).status).toBe(423);

      const raw = `lockout-${tag}`;
      await plantToken(userId, raw);
      const done = await api.post('/api/auth/password/reset').send({ token: raw, password: 'Unlocked!2026' });
      expect(done.status).toBe(200);

      const row = (
        await db(`SELECT status, failed_attempts, locked_until, must_change_password FROM users WHERE id=$1`, [userId])
      ).rows[0];
      expect(String(row.status)).toBe('ACTIVE');
      expect(Number(row.failed_attempts)).toBe(0);
      expect(row.locked_until).toBeNull();

      // Recovery ends every session that predates it.
      expect((await api.get('/api/auth/me').set(auth(older))).status).toBe(401);
      expect((await api.post('/api/auth/login').send({ identifier: username, password: 'Unlocked!2026' })).status).toBe(200);
    } finally {
      await dropResetUser(userId);
    }
  });

  it('rejects a forged, expired or too-short reset attempt', async () => {
    const { userId } = await createResetUser();
    try {
      expect(
        (await api.post('/api/auth/password/reset').send({ token: `forged-${tag}`, password: 'Whatever!2026' })).status
      ).toBe(401);
      expect((await api.post('/api/auth/password/reset').send({ token: '', password: 'Whatever!2026' })).status).toBe(400);
      expect((await api.post('/api/auth/password/reset').send({ token: 'x'.repeat(24), password: 'short' })).status).toBe(400);

      const stale = `stale-${tag}`;
      await plantToken(userId, stale, `-1 minute`);
      expect((await api.post('/api/auth/password/reset').send({ token: stale, password: 'Whatever!2026' })).status).toBe(401);
    } finally {
      await dropResetUser(userId);
    }
  });

  it('accepts one account however the identifier is typed', async () => {
    const { userId, email, username } = await createResetUser();
    try {
      const variants = [email, email.toUpperCase(), `  ${email}  `, username, username.toUpperCase(), username.replace('.', '_')];
      for (const identifier of variants) {
        const res = await api.post('/api/auth/login').send({ identifier, password: PASSWORD });
        expect(res.status, `login as ${identifier}`).toBe(200);
        expect(typeof res.body.accessToken).toBe('string');
      }
    } finally {
      await dropResetUser(userId);
    }
  });

  it('accepts an eight-character password change', async () => {
    const { userId, username } = await createResetUser();
    try {
      const login = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      const token = login.body.accessToken as string;
      const res = await api
        .post('/api/auth/change-password')
        .set(auth(token))
        .send({ currentPassword: PASSWORD, newPassword: 'Eight888' });
      expect(res.status).toBe(200);
      expect((await api.post('/api/auth/login').send({ identifier: username, password: 'Eight888' })).status).toBe(200);
    } finally {
      await dropResetUser(userId);
    }
  });
});

describe('Second-factor readiness', () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** Throwaway account in tenant 2, so seeded users keep their own MFA state. */
  async function createMfaUser() {
    const { hashPassword } = await import('../src/auth.js');
    const username = `mfa.${tag}`;
    const email = `${username}@hopedesign.test`;
    const ins = await db(
      `INSERT INTO users (tenant_id, company_id, branch_id, email, username, password_hash, first_name, last_name, status)
       VALUES (2, 2, 2, $1, $2, $3, 'Second', 'Factor', 'ACTIVE') RETURNING id`,
      [email, username, await hashPassword(PASSWORD)]
    );
    return { userId: Number(ins.rows[0].id), email, username };
  }

  /** mfa_methods rows cascade with the account; sessions hold a plain FK. */
  async function dropMfaUser(userId: number) {
    await db(`DELETE FROM mfa_email_codes WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await db(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  /** TOTP is time-based; retry once so a 30s rollover is not read as a failure. */
  async function verifyTotpChallenge(loginToken: string, secret: string) {
    const attempt = async () =>
      api.post('/api/auth/mfa/verify').send({ loginToken, code: authenticator.generate(secret) });
    let res = await attempt();
    if (res.status !== 200) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await attempt();
    }
    return res;
  }

  it('offers enrolment instead of an unanswerable challenge, and accepts the account once paired', async () => {
    const { userId, username } = await createMfaUser();
    try {
      const { generateTotpSecret } = await import('../src/auth.js');
      const abandoned = generateTotpSecret();
      // The production dead end: flagged TOTP with a secret left behind by an
      // enrolment that started and never finished, so no verified method row.
      await db(`UPDATE users SET mfa_enabled=true, mfa_method='TOTP', mfa_secret=$1 WHERE id=$2`, [abandoned, userId]);

      const blocked = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      expect(blocked.status).toBe(200);
      expect(blocked.body.enrollmentRequired).toBe(true);
      expect(blocked.body.method).toBe('email');

      // A challenge for an unpaired authenticator must say so, not loop the
      // holder on codes their account can never match.
      const stale = await api
        .post('/api/auth/mfa/verify')
        .send({ loginToken: blocked.body.loginToken, code: authenticator.generate(abandoned) });
      expect(stale.status).toBe(400);
      expect(String(stale.body.error.message)).toContain('No authenticator app is paired');

      // Repair through the enrolment screen the login response pointed at.
      const start = await api.post('/api/auth/mfa/enroll-start').send({ loginToken: blocked.body.loginToken });
      expect(start.status).toBe(200);
      const secret = String(start.body.secret ?? '');
      expect(secret).toBeTruthy();
      const paired = await api
        .post('/api/auth/mfa/enroll-verify')
        .send({ loginToken: blocked.body.loginToken, code: authenticator.generate(secret), secret });
      expect(paired.status).toBe(200);
      expect(typeof paired.body.accessToken).toBe('string');

      // Pairing is recorded, so the account is no longer "protected" on paper only.
      const methods = await db(`SELECT method, verified_at, is_active FROM mfa_methods WHERE user_id=$1`, [userId]);
      expect(methods.rows).toHaveLength(1);
      expect(methods.rows[0].method).toBe('TOTP');
      expect(methods.rows[0].verified_at).toBeTruthy();
      expect(methods.rows[0].is_active).toBe(true);

      // The same password now reaches the paired factor instead of enrolment.
      const challenge = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      expect(challenge.body.mfaRequired).toBe(true);
      expect(challenge.body.enrollmentRequired).toBeFalsy();
      expect(challenge.body.method).toBe('totp');
      const done = await verifyTotpChallenge(String(challenge.body.loginToken), secret);
      expect(done.status).toBe(200);
      expect(typeof done.body.accessToken).toBe('string');

      // A paired factor carries the account; the stale secret was replaced.
      const row = await db(`SELECT mfa_secret FROM users WHERE id=$1`, [userId]);
      expect(String(row.rows[0].mfa_secret)).toBe(secret);
      expect(String(row.rows[0].mfa_secret)).not.toBe(abandoned);
    } finally {
      await dropMfaUser(userId);
    }
  });

  it('refuses to re-enrol an account whose factor already works', async () => {
    const { userId, username } = await createMfaUser();
    try {
      const { generateTotpSecret } = await import('../src/auth.js');
      const secret = generateTotpSecret();
      // A completed pairing: the secret and the verified method row it writes.
      await db(
        `UPDATE users SET mfa_enabled=true, mfa_method='TOTP', mfa_secret=$1 WHERE id=$2`,
        [secret, userId]
      );
      await db(
        `INSERT INTO mfa_methods (tenant_id, user_id, method, verified_at, is_active)
         VALUES (2, $1, 'TOTP', now(), true)`,
        [userId]
      );
      const challenge = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
      expect(challenge.body.mfaRequired).toBe(true);
      expect(challenge.body.enrollmentRequired).toBeFalsy();
      expect(challenge.body.method).toBe('totp');

      const start = await api.post('/api/auth/mfa/enroll-start').send({ loginToken: challenge.body.loginToken });
      expect(start.status).toBe(400);
      expect(String(start.body.error.message)).toContain('already set up');
    } finally {
      await dropMfaUser(userId);
    }
  });
});
