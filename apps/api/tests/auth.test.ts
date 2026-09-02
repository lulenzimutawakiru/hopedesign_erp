import { describe, it, expect } from 'vitest';
import { api, PASSWORD, auth, loginAs, db, deleteEmployees } from './helpers.js';

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
