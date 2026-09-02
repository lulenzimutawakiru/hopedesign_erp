import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pool } from './helpers.js';

/**
 * DB-002 regression tests (retest as a non-owner role).
 *
 * The application must be able to run as `hopedesign_app`, a non-superuser,
 * non-BYPASSRLS role, with FORCE ROW LEVEL SECURITY enforcing the tenant
 * boundary at the database layer. These tests replay the exploit probes from
 * the assessment against that role and assert fail-closed behaviour:
 *   - tenant context is mandatory (no context => no rows, writes denied),
 *   - cross-tenant rows are invisible and unaffected by writes (both
 *     directions: tenant 2 cannot touch the fixture tenant and vice versa),
 *   - in-tenant reads/writes work,
 *   - audit_logs is append-only,
 *   - privilege escalation (role/table creation) is denied.
 *
 * Fixture note: the second tenant + its sentinel company are created against
 * the `companies` table (FORCE RLS, tenant_isolation policy, no audit trigger)
 * so the fixture leaves zero residue after cleanup.
 */

const APP_USER = process.env.POSTGRES_APP_USER ?? 'hopedesign_app';
const APP_PASSWORD = process.env.POSTGRES_APP_PASSWORD ?? 'hopedesign_app_dev';
const FIXTURE_TENANT_CODE = `rls-tenant-${process.pid}`;
const SENTINEL_CODE = `rls-sentinel-${process.pid}`;
const PROBE_CODE = `rls-probe-${process.pid}`;

let fixtureTenantId: number | null = null;
let fixtureCompanyId: number | null = null;

function appClient(): pg.Client {
  return new pg.Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: APP_USER,
    password: APP_PASSWORD,
    database: process.env.POSTGRES_DB ?? 'hopedesign_erp',
  });
}

/** Run a callback inside a transaction with tenant/company context,
 * mirroring apps/api/src/db.ts (BEGIN -> set_app_context -> work -> ROLLBACK). */
async function asTenant<T>(tenantId: number, companyId: number, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = appClient();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_app_context($1,$2,$3,$4)', [tenantId, companyId, null, 1]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** Run a callback outside any app context (autocommit, tenant GUC unset). */
async function withoutContext<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = appClient();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('RLS isolation for the least-privilege app role (DB-002)', () => {
  beforeAll(async () => {
    const ten = await pool.query(
      `INSERT INTO tenants (code, name) VALUES ($1, 'RLS isolation fixture tenant') RETURNING id`,
      [FIXTURE_TENANT_CODE]
    );
    fixtureTenantId = Number(ten.rows[0].id);
    const co = await pool.query(
      `INSERT INTO companies (tenant_id, code, name) VALUES ($1, $2, 'RLS sentinel company') RETURNING id`,
      [fixtureTenantId, SENTINEL_CODE]
    );
    fixtureCompanyId = Number(co.rows[0].id);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM companies WHERE code = ANY($1)', [[SENTINEL_CODE, PROBE_CODE]]);
    } catch {
      // best-effort cleanup; probe rows are rolled back by design
    }
    if (fixtureCompanyId) {
      try {
        await pool.query('DELETE FROM companies WHERE id = $1', [fixtureCompanyId]);
      } catch {
        // best-effort cleanup
      }
    }
    if (fixtureTenantId) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [fixtureTenantId]);
    }
  });

  it('runs as a non-superuser role that cannot bypass RLS', async () => {
    const { rows } = await pool.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
         FROM pg_roles WHERE rolname = $1`,
      [APP_USER]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolcreaterole).toBe(false);
  });

  it('has FORCE row-level security active on tenant tables', async () => {
    const { rows } = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname IN ('companies', 'customers')`
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('fails closed when no tenant context is set', async () => {
    const n = await withoutContext(async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM companies');
      return r.rows[0].n as number;
    });
    // With no tenant GUC the tenant policy matches nothing.
    expect(n).toBe(0);

    // Writes without tenant context must be denied, not silently scoped.
    const err = await withoutContext(async (c) => {
      try {
        await c.query(
          `INSERT INTO companies (tenant_id, code, name) VALUES ($1, 'no-ctx', 'no-ctx')`,
          [fixtureTenantId]
        );
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toMatch(/row-level security|permission denied/i);
  });

  it('sees only its own tenant and cannot touch another tenant row', async () => {
    const seen = await asTenant(2, 2, async (c) => {
      const probe = await c.query(
        `INSERT INTO companies (tenant_id, code, name) VALUES (2, $1, 'RLS probe') RETURNING id`,
        [PROBE_CODE]
      );
      const own = await c.query('SELECT count(*)::int AS n FROM companies WHERE id = $1', [
        probe.rows[0].id,
      ]);
      const foreign = await c.query(
        'SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1 AND code = $2',
        [fixtureTenantId, SENTINEL_CODE]
      );
      const crossUpdate = await c.query(
        'UPDATE companies SET name = $1 WHERE tenant_id = $2 AND code = $3',
        ['should not apply', fixtureTenantId, SENTINEL_CODE]
      );
      const crossDelete = await c.query(
        'DELETE FROM companies WHERE tenant_id = $1 AND code = $2',
        [fixtureTenantId, SENTINEL_CODE]
      );
      return {
        own: own.rows[0].n as number,
        foreign: foreign.rows[0].n as number,
        crossUpdate: crossUpdate.rowCount ?? 0,
        crossDelete: crossDelete.rowCount ?? 0,
      };
    });
    expect(seen.own).toBe(1);
    expect(seen.foreign).toBe(0);
    expect(seen.crossUpdate).toBe(0);
    expect(seen.crossDelete).toBe(0);

    // Reverse direction: the fixture tenant cannot see tenant 2's company.
    const reverse = await asTenant(fixtureTenantId!, fixtureCompanyId!, async (c) => {
      const own = await c.query('SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1', [
        fixtureTenantId,
      ]);
      const other = await c.query('SELECT count(*)::int AS n FROM companies WHERE tenant_id = 2');
      return { own: own.rows[0].n as number, other: other.rows[0].n as number };
    });
    expect(reverse.own).toBe(1);
    expect(reverse.other).toBe(0);

    // The other-tenant sentinel row is untouched by the app role.
    const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [fixtureCompanyId]);
    expect(rows[0].name).toBe('RLS sentinel company');
  });

  it('supports in-tenant writes (insert/update/delete) end to end', async () => {
    await asTenant(2, 2, async (c) => {
      const inserted = await c.query(
        `INSERT INTO companies (tenant_id, code, name) VALUES (2, $1, 'RLS probe') RETURNING id`,
        [PROBE_CODE]
      );
      const id = inserted.rows[0].id as number;
      const updated = await c.query('UPDATE companies SET name = $1 WHERE id = $2', [
        'RLS probe updated',
        id,
      ]);
      const read = await c.query('SELECT name FROM companies WHERE id = $1', [id]);
      const deleted = await c.query('DELETE FROM companies WHERE id = $1', [id]);
      expect(updated.rowCount).toBe(1);
      expect(read.rows[0].name).toBe('RLS probe updated');
      expect(deleted.rowCount).toBe(1);
    });
  });

  it('keeps audit_logs append-only for the app role', async () => {
    const result = await asTenant(2, 2, async (c) => {
      const inserted = await c.query(
        `INSERT INTO audit_logs (tenant_id, company_id, user_id, action, resource, ip)
         VALUES (2, 2, 1, 'rls.probe', 'companies', '127.0.0.1') RETURNING id`
      );
      // Each denied statement aborts the transaction; observe each with its
      // own savepoint so one failure does not mask the other.
      let updateError = '';
      let deleteError = '';
      await c.query('SAVEPOINT rls_update');
      try {
        await c.query('UPDATE audit_logs SET action = $1 WHERE id = $2', ['x', inserted.rows[0].id]);
      } catch (e) {
        updateError = (e as Error).message;
      }
      await c.query('ROLLBACK TO SAVEPOINT rls_update');
      await c.query('SAVEPOINT rls_delete');
      try {
        await c.query('DELETE FROM audit_logs WHERE id = $1', [inserted.rows[0].id]);
      } catch (e) {
        deleteError = (e as Error).message;
      }
      return { inserted: Boolean(inserted.rows[0].id), updateError, deleteError };
    });
    expect(result.inserted).toBe(true);
    expect(result.updateError).toMatch(/permission denied/i);
    expect(result.deleteError).toMatch(/permission denied/i);
  });

  it('denies privilege escalation (role/table creation)', async () => {
    const result = await asTenant(2, 2, async (c) => {
      const outcomes: string[] = [];
      for (const sql of ['CREATE ROLE rls_evil', 'CREATE TABLE public.rls_evil (id int)']) {
        try {
          await c.query(sql);
          outcomes.push('ALLOWED');
        } catch {
          outcomes.push('DENIED');
        }
      }
      return outcomes;
    });
    expect(result).toEqual(['DENIED', 'DENIED']);
  });
});
