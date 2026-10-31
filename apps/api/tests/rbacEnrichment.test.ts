import { describe, it, expect, beforeAll } from 'vitest';
import { api, auth, db, loginAs } from './helpers.js';

/**
 * Dual-Super-Administrator / multi-role authorization enrichment.
 *
 * Covers the pieces migration 0210 adds on top of the existing RBAC engine:
 *  - role-assignment metadata (department, assigner, expiry, status) and its
 *    enforcement (expired / inactive / revoked roles grant nothing),
 *  - per-user permission overrides (grant adds a code, revoke removes one),
 *  - override expiry being honoured the same way.
 *
 * `sarah.sales` is the target: she holds `sales.*` but not the inventory
 * movement permission, which makes the grant/revoke boundary unambiguous.
 */

type Row = Record<string, unknown>;

const ADMIN = 'admin';
const TARGET = 'sarah.sales';
const GRANTED_PERM = 'inventory.movements.create';

async function userIdOf(username: string): Promise<number> {
  const res = await db('SELECT id FROM users WHERE username = $1 OR email = $1', [username]);
  return Number(res.rows[0].id);
}

async function getMe(token: string) {
  const res = await api.get('/api/auth/me').set(auth(token));
  expect(res.status).toBe(200);
  return res.body.user as { id: number; permissions: string[]; roles: Row[] };
}

async function removeOverridesFor(userId: number, permCode: string) {
  await db(
    `DELETE FROM user_permission_overrides
      WHERE user_id = $1 AND permission_id = (SELECT id FROM permissions WHERE code = $2)`,
    [userId, permCode]
  );
}

let adminToken = '';
let targetId = 0;

beforeAll(async () => {
  adminToken = (await loginAs(ADMIN)).token;
  targetId = await userIdOf(TARGET);
});

describe('Permission overrides', () => {
  it('a grant override adds a permission the roles do not carry', async () => {
    const target = await loginAs(TARGET);
    const before = await getMe(target.token);
    expect(before.permissions).not.toContain(GRANTED_PERM);

    try {
      const grant = await api
        .post(`/api/admin/users/${targetId}/permission-overrides`)
        .set(auth(adminToken))
        .send({ permission: GRANTED_PERM, effect: 'grant' });
      expect(grant.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).toContain(GRANTED_PERM);
    } finally {
      await removeOverridesFor(targetId, GRANTED_PERM);
    }
  });

  it('a revoke override removes a permission the roles do carry', async () => {
    const target = await loginAs(TARGET);
    const before = await getMe(target.token);
    const victim = before.permissions.find((p) => p !== 'system.admin.all' && p !== '*');
    expect(victim).toBeTruthy();

    try {
      const revoke = await api
        .post(`/api/admin/users/${targetId}/permission-overrides`)
        .set(auth(adminToken))
        .send({ permission: victim, effect: 'revoke' });
      expect(revoke.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).not.toContain(victim);
    } finally {
      await removeOverridesFor(targetId, victim!);
    }
  });

  it('an expired override grants nothing', async () => {
    const target = await loginAs(TARGET);
    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    try {
      const grant = await api
        .post(`/api/admin/users/${targetId}/permission-overrides`)
        .set(auth(adminToken))
        .send({ permission: GRANTED_PERM, effect: 'grant', expires_at: past });
      expect(grant.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).not.toContain(GRANTED_PERM);
    } finally {
      await removeOverridesFor(targetId, GRANTED_PERM);
    }
  });
});

describe('Role-assignment metadata and expiry', () => {
  async function operationsDirectorRoleId(): Promise<number> {
    const res = await db(
      `SELECT r.id FROM roles r
        JOIN users u ON u.tenant_id = r.tenant_id
       WHERE u.username = $1 AND r.code = 'operations_director'
       ORDER BY r.id LIMIT 1`,
      [ADMIN]
    );
    return Number(res.rows[0].id);
  }

  it('an expired role assignment grants none of its permissions', async () => {
    const roleId = await operationsDirectorRoleId();
    const target = await loginAs(TARGET);
    const before = await getMe(target.token);
    expect(before.permissions).not.toContain('inventory.movements.view');

    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    try {
      const assign = await api
        .post(`/api/admin/users/${targetId}/roles`)
        .set(auth(adminToken))
        .send({ role_id: roleId, expires_at: past });
      expect(assign.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).not.toContain('inventory.movements.view');
    } finally {
      await db('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [targetId, roleId]);
    }
  });

  it('an active, unexpired role assignment grants its permissions', async () => {
    const roleId = await operationsDirectorRoleId();
    const target = await loginAs(TARGET);
    try {
      const assign = await api
        .post(`/api/admin/users/${targetId}/roles`)
        .set(auth(adminToken))
        .send({ role_id: roleId });
      expect(assign.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).toContain('inventory.movements.view');
      const role = after.roles.find((r) => r.role_code === 'operations_director');
      expect(role).toBeTruthy();
    } finally {
      await db('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [targetId, roleId]);
    }
  });

  it('a revoked role assignment grants nothing', async () => {
    const roleId = await operationsDirectorRoleId();
    const target = await loginAs(TARGET);
    try {
      const assign = await api
        .post(`/api/admin/users/${targetId}/roles`)
        .set(auth(adminToken))
        .send({ role_id: roleId, status: 'REVOKED' });
      expect(assign.status).toBe(200);

      const after = await getMe(target.token);
      expect(after.permissions).not.toContain('inventory.movements.view');
    } finally {
      await db('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [targetId, roleId]);
    }
  });
});

describe('Multiple roles per user', () => {
  async function operationsDirectorRoleId(): Promise<number> {
    const res = await db(
      `SELECT r.id FROM roles r
        JOIN users u ON u.tenant_id = r.tenant_id
       WHERE u.username = $1 AND r.code = 'operations_director'
       ORDER BY r.id LIMIT 1`,
      [ADMIN]
    );
    return Number(res.rows[0].id);
  }

  it('adding a second role keeps the first and unions permissions', async () => {
    const roleId = await operationsDirectorRoleId();
    const target = await loginAs(TARGET);
    const before = await getMe(target.token);
    const beforeRoleCodes = before.roles.map((r) => String(r.role_code));
    const beforePermissions = [...before.permissions];

    // sarah.sales already holds her sales role; assigning a second role must
    // not drop it, and the permission set must be the union of both roles.
    try {
      const assign = await api
        .post(`/api/admin/users/${targetId}/roles`)
        .set(auth(adminToken))
        .send({ role_id: roleId });
      expect(assign.status).toBe(200);

      const after = await getMe(target.token);
      const afterRoleCodes = after.roles.map((r) => String(r.role_code));

      // Both roles are held at once.
      expect(after.roles.length).toBeGreaterThan(before.roles.length);
      expect(afterRoleCodes).toEqual(expect.arrayContaining(beforeRoleCodes));
      expect(afterRoleCodes).toContain('operations_director');

      // Permissions are the union: the new role's codes appear, the old survive.
      expect(after.permissions).toContain('inventory.movements.view');
      expect(after.permissions).toEqual(expect.arrayContaining(beforePermissions));
    } finally {
      await db('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [targetId, roleId]);
    }
  });
});
