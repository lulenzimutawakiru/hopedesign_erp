import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, db } from './helpers.js';
import { tx } from '../src/db.js';
import type { Ctx } from '../src/db.js';
import {
  ORG_VIEW_PERMISSION,
  catalogueIndex,
  categoryHistory,
  getCategory,
  isStructureCategory,
  loadCategory,
  readCategorySecret,
  saveCategory,
  searchSettings,
  structureSummary,
} from '../src/services/organisationSettings/index.js';
import * as integrations from '../src/services/organisationSettings/integrations.js';
import * as structure from '../src/services/organisationSettings/structure.js';

/**
 * Organisation Settings - the control plane for the whole ERP.
 *
 * These tests drive the service layer directly rather than the HTTP router,
 * because the invariants at stake (a secret that round-trips, a sequence that
 * cannot duplicate, a period ladder that only moves one way) are service-level
 * facts. Router-level permission behaviour is covered separately.
 */

const TENANT_ID = 2;
const COMPANY_ID = 2;
const BRANCH_ID = 2;
const ADMIN_ID = 1;

const ctx: Ctx = {
  tenantId: TENANT_ID,
  companyId: COMPANY_ID,
  branchId: BRANCH_ID,
  userId: ADMIN_ID,
  correlationId: 'test-org-settings',
  ip: '127.0.0.1',
  userAgent: 'vitest',
};

const tag = () => 'ORGSET' + Math.random().toString(36).slice(2, 8).toUpperCase();

// ---------------------------------------------------------------------------
// The database is a shared resource: this suite snapshots the rows it can
// touch and restores them, so it stays re-runnable against a dev database that
// already has real settings saved in it.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let appSettingsBefore: Row[] = [];
let companyBefore: Row | null = null;
let integrationsBefore: Row[] = [];

beforeAll(async () => {
  appSettingsBefore = (
    await db(
      `SELECT tenant_id, company_id, category, key, value, is_secret, updated_by
         FROM app_settings WHERE tenant_id = $1 AND category LIKE 'organisation.%'`,
      [TENANT_ID]
    )
  ).rows;
  companyBefore = (
    await db('SELECT * FROM companies WHERE id = $1 AND tenant_id = $2', [COMPANY_ID, TENANT_ID])
  ).rows[0] ?? null;
  integrationsBefore = (
    await db('SELECT * FROM company_integrations WHERE tenant_id = $1', [TENANT_ID])
  ).rows;
});

afterAll(async () => {
  // Settings written by this suite live under organisation.* - clear them and
  // put back whatever was there first.
  await db(`DELETE FROM app_settings WHERE tenant_id = $1 AND category LIKE 'organisation.%'`, [TENANT_ID]);
  for (const r of appSettingsBefore) {
    await db(
      `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [r.tenant_id, r.company_id, r.category, r.key, JSON.stringify(r.value), r.is_secret, r.updated_by]
    );
  }

  if (companyBefore) {
    await db(
      `UPDATE companies SET legal_name=$2, tin=$3, vrn=$4, currency=$5, phone=$6, email=$7,
              website=$8, address=$9, fiscal_year_start=$10, specialty=$11
        WHERE id=$1`,
      [
        COMPANY_ID,
        companyBefore.legal_name, companyBefore.tin, companyBefore.vrn, companyBefore.currency,
        companyBefore.phone, companyBefore.email, companyBefore.website, companyBefore.address,
        companyBefore.fiscal_year_start, companyBefore.specialty,
      ]
    );
  }

  await db('DELETE FROM company_integrations WHERE tenant_id = $1', [TENANT_ID]);
  for (const r of integrationsBefore) {
    await db(
      `INSERT INTO company_integrations
         (tenant_id, company_id, category, code, name, description, config, secrets, status, is_active, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [
        r.tenant_id, r.company_id, r.category, r.code, r.name, r.description,
        JSON.stringify(r.config), JSON.stringify(r.secrets), r.status, r.is_active, r.updated_by,
      ]
    );
  }
  await pool.end();
});

describe('organisation settings catalogue', () => {
  it('exposes the full category tree under one view permission', () => {
    const index = catalogueIndex();
    expect(index.viewPermission).toBe(ORG_VIEW_PERMISSION);
    expect(index.categories.length).toBeGreaterThan(25);

    const ids = index.categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('profile');
    expect(ids).toContain('tax');
    expect(ids).toContain('security');
    expect(ids).toContain('integrations');
    // The seven structural entities are categories too.
    for (const id of ['companies', 'branches', 'departments', 'divisions', 'locations', 'warehouses', 'cost_centres']) {
      expect(ids, id + ' missing from the catalogue').toContain(id);
      expect(isStructureCategory(id)).toBe(true);
    }
    expect(isStructureCategory('profile')).toBe(false);
  });

  it('gates every category behind a manage permission', () => {
    for (const c of catalogueIndex().categories) {
      expect(c.manage, c.id + ' has no manage permission').toMatch(/^organisation\./);
    }
  });

  it('resolves a category by id and refuses an unknown one', () => {
    expect(getCategory('profile').id).toBe('profile');
    expect(getCategory('warehouses').id).toBe('warehouses');
    expect(() => getCategory('nope')).toThrow();
  });

  it('finds settings by label and by key', () => {
    const byLabel = searchSettings('legal');
    expect(byLabel.length).toBeGreaterThan(0);
    expect(byLabel.some((h) => h.categoryId === 'profile')).toBe(true);
    expect(searchSettings('')).toEqual([]);
  });
});

describe('loadCategory', () => {
  it('loads every category in the catalogue without error', async () => {
    const failures: string[] = [];
    for (const c of catalogueIndex().categories) {
      try {
        const view = await tx((client) => loadCategory(client, ctx, c.id), ctx);
        expect(view.category.id).toBe(c.id);
        expect(view.kind).toBe(c.kind);
      } catch (err) {
        failures.push(c.id + ': ' + (err as Error).message);
      }
    }
    expect(failures).toEqual([]);
  });

  it('returns company identity for the root company row', async () => {
    const view = await tx((client) => loadCategory(client, ctx, 'companies'), ctx);
    const rows = view.list as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => Number(r.id) === COMPANY_ID)).toBe(true);
  });
});
