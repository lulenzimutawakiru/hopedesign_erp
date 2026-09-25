import { afterEach, describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pool, db } from './helpers.js';
import type { Ctx } from '../src/db.js';
import {
  appliesToEmployment,
  computeLst,
  computeNssf,
  computePaye,
  computeSecondaryPaye,
  employmentScopes,
  getStatutoryConfig,
  requireStatutoryConfig,
  statutorySnapshot,
  type StatutoryConfig,
} from '../src/services/statutory.js';
import {
  acceptStatutoryFiling,
  cancelStatutoryFiling,
  createStatutoryFiling,
  getStatutoryFiling,
  listStatutoryFilings,
  prepareStatutoryFiling,
  reconcileStatutoryFiling,
  recordStatutoryPayment,
  submitStatutoryFiling,
} from '../src/services/statutoryFilings.js';
import { prepareStatutoryConfig } from '../src/services/payrollSettings.js';

/**
 * Uganda statutory rule engine.
 *
 * The payroll engine reads PAYE/NSSF/LST out of versioned `statutory_configs`
 * rows, so the two things that must never regress are (a) the arithmetic of
 * each banded calculation and (b) the effective-date resolution that decides
 * which rule version a past period is allowed to use. This file pins both, plus
 * the statutory-filing workflow that reconciles a return against what was
 * actually settled.
 *
 * Nothing here creates a payroll run: the filing fixtures use their own
 * periods, so this file cannot collide with the payroll-run month budgets used
 * by the lifecycle and engine suites.
 */

const CTX: Ctx = { tenantId: 2, companyId: 2, userId: 15 };

/** Minimal well-formed rule row; every test overrides only what it exercises. */
const config = (over: Partial<StatutoryConfig>): StatutoryConfig => ({
  id: 0,
  companyId: null,
  tenantId: 2,
  country: 'UG',
  category: 'PAYE',
  code: 'TEST-CFG',
  name: 'Test configuration',
  description: null,
  effectiveFrom: null,
  effectiveTo: null,
  rates: [],
  thresholds: [],
  limits: {},
  formula: null,
  version: 1,
  status: 'ACTIVE',
  ...over,
});

/** Band-object form: rates = [{ min, max, rate }]. */
const bandConfig = (bands: Array<[number, number | null, number]>, code = 'TEST-PAYE') =>
  config({ code, rates: bands.map(([min, max, rate]) => ({ min, max, rate })) });

// Uganda PAYE bands as legislated for FY2023/24 and FY2026/27. Kept as literals
// here so a change to the seeded rows cannot quietly re-baseline the tests.
const UG_2023_BANDS: Array<[number, number | null, number]> = [
  [0, 235000, 0],
  [235000, 335000, 10],
  [335000, 410000, 20],
  [410000, 10000000, 30],
  [10000000, null, 40],
];
const UG_2026_BANDS: Array<[number, number | null, number]> = [
  [0, 335000, 0],
  [335000, 410000, 20],
  [410000, 485000, 25],
  [485000, 10000000, 30],
  [10000000, null, 40],
];

describe('statutory rule engine', () => {
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await db(`DELETE FROM statutory_submissions WHERE period_start >= '2027-10-01'`);
  });

  afterAll(async () => {
    await db(`DELETE FROM statutory_submissions WHERE period_start >= '2027-10-01'`);
    if (client) client.release();
  });

  describe('PAYE bands', () => {
    it('charges nothing on nil or below-threshold income', () => {
      const cfg = bandConfig(UG_2023_BANDS);
      expect(computePaye(0, cfg)).toBe(0);
      expect(computePaye(235000, cfg)).toBe(0);
      expect(computePaye(-5000, cfg)).toBe(0);
    });

    it('walks every band of the FY2023/24 schedule', () => {
      const cfg = bandConfig(UG_2023_BANDS);
      // Band 1 is exempt, so the tax only starts at 235,000.
      expect(computePaye(300000, cfg)).toBe(6500); // 65,000 x 10%
      expect(computePaye(335000, cfg)).toBe(10000); // 100,000 x 10%
      expect(computePaye(410000, cfg)).toBe(25000); // + 75,000 x 20%
      expect(computePaye(10000000, cfg)).toBe(2902000); // + 9,590,000 x 30%
      expect(computePaye(11000000, cfg)).toBe(3302000); // + 1,000,000 x 40%
    });

    it('lands exactly on each band boundary', () => {
      const cfg = bandConfig(UG_2026_BANDS);
      expect(computePaye(335000, cfg)).toBe(0);
      expect(computePaye(335001, cfg)).toBeCloseTo(0.2, 2);
      expect(computePaye(410000, cfg)).toBe(15000);
      expect(computePaye(485000, cfg)).toBe(33750);
      expect(computePaye(10000000, cfg)).toBe(2888250);
    });

    it('caps the top band at the open-ended rate', () => {
      const cfg = bandConfig(UG_2026_BANDS);
      // Everything above 10,000,000 is charged at 40% with no ceiling.
      const base = computePaye(10000000, cfg);
      expect(computePaye(20000000, cfg)).toBeCloseTo(base + 10000000 * 0.4, 2);
    });

    it('rejects a configuration with no usable bands', () => {
      expect(() => computePaye(1000000, config({ code: 'UG-EMPTY', rates: [] }))).toThrow(/no rate bands/);
      expect(() => computePaye(1000000, config({ code: 'UG-EMPTY', rates: null }))).toThrow(/no rate bands/);
    });

    it('supports the parallel thresholds + rates form', () => {
      // thresholds carry min/max, rates carry the percentage. A threshold-aligned
      // rates array also has a `rate` key, so this asserts the engine does not
      // mistake it for the band-object form and charge the whole amount at the
      // last band's rate.
      const cfg = config({
        code: 'TEST-PARALLEL',
        thresholds: [
          { min: 0, max: 100 },
          { min: 100, max: null },
        ],
        rates: [{ rate: 0 }, { rate: 10 }],
      });
      expect(computePaye(50, cfg)).toBe(0);
      expect(computePaye(100, cfg)).toBe(0);
      expect(computePaye(150, cfg)).toBe(5);
      expect(computePaye(200, cfg)).toBe(10);
    });

    it('resolves the same bands from the seeded rows and reproduces them', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2027-01-15' });
      expect(cfg.code).toBe('UG-PAYE-2026');
      // Gross 3,000,000 less employee NSSF 150,000 is the chargeable income the
      // payroll engine feeds in; PAYE on 2,850,000 is the seeded reference value.
      expect(computePaye(2850000, cfg)).toBe(743250);
    });

    it('seeds the legislated FY2026/27 bands, not the superseded schedule', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2027-01-15' });
      // The seeded row is what a rebuilt or newly onboarded database charges
      // from. Pin it to the same literals the engine tests use: this code once
      // shipped carrying the FY2023/24 bands, which would have mis-taxed every
      // period from 1 July 2026 without the arithmetic tests noticing.
      const stored = (cfg.rates as Array<{ min: number; max: number | null; rate: number }>).map(
        (b) => [b.min, b.max, b.rate] as [number, number | null, number]
      );
      expect(stored).toEqual(UG_2026_BANDS);
      expect(cfg.version).toBe(2);
    });

    it('closes the superseded FY2023/24 schedule at 30 June 2026', async () => {
      // Effective dating already prefers the 2026 row; closing the old version
      // is what stops it reading as the current rule in settings and returns.
      const { rows } = await client.query(
        `SELECT effective_to::text AS effective_to
           FROM statutory_configs
          WHERE tenant_id = $1
            AND company_id IS NULL
            AND category = 'PAYE'
            AND code = 'UG-PAYE-2023'`,
        [CTX.tenantId]
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.effective_to).toBe('2026-06-30');
    });
  });

  describe('effective dating', () => {
    it('selects the rule version that was law on the payroll date', async () => {
      const historical = await getStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2024-06-15' });
      expect(historical?.code).toBe('UG-PAYE-2023');

      const boundary = await getStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2026-06-30' });
      expect(boundary?.code).toBe('UG-PAYE-2023');

      const current = await getStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2026-07-01' });
      expect(current?.code).toBe('UG-PAYE-2026');

      const future = await getStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2030-01-01' });
      expect(future?.code).toBe('UG-PAYE-2026');
    });

    it('returns nothing for a date before any rule existed', async () => {
      expect(await getStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2020-01-01' })).toBeNull();
      await expect(requireStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2020-01-01' }))
        .rejects.toThrow(/No ACTIVE statutory configuration/);
    });

    it('prefers a company-specific rule over the tenant-wide default', async () => {
      const tenantWide = await getStatutoryConfig(client, CTX, 'LST', { effectiveDate: '2027-01-01', companyId: null });
      expect(tenantWide?.code).toBe('UG-LST-2023');

      const scoped = await getStatutoryConfig(client, CTX, 'LST', { effectiveDate: '2027-01-01', companyId: 2 });
      expect(scoped?.code).toBe('UG-LST-KCCA');
    });

    it('snapshots the rule so a historical run can be reproduced', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'PAYE', { effectiveDate: '2024-06-15' });
      const snap = statutorySnapshot(cfg);
      expect(snap.code).toBe('UG-PAYE-2023');
      expect(snap.version).toBe(cfg.version);
      // The stored bands travel with the snapshot, so reproducing an old run
      // never depends on the current table contents.
      expect(Array.isArray(snap.rates)).toBe(true);
      expect((snap.rates as unknown[]).length).toBe(5);
    });
  });

  describe('NSSF', () => {
    const nssf = (over: Partial<StatutoryConfig> = {}) =>
      config({ category: 'NSSF', code: 'TEST-NSSF', rates: { employee: 0.05, employer: 0.1 }, limits: { monthly_ceiling: 0 }, ...over });

    it('splits employee and employer contribution', () => {
      const r = computeNssf(3000000, nssf());
      expect(r.employee).toBe(150000);
      expect(r.employer).toBe(300000);
      expect(r.base).toBe(3000000);
      expect(r.ceiling).toBeNull();
    });

    it('rounds a fractional contribution to two decimals', () => {
      const r = computeNssf(333333, nssf());
      expect(r.employee).toBe(16666.65);
      expect(r.employer).toBe(33333.3);
    });

    it('clamps the contribution base to a configured ceiling', () => {
      const capped = nssf({ limits: { monthly_ceiling: 500000 } });
      const r = computeNssf(3000000, capped);
      expect(r.base).toBe(500000);
      expect(r.ceiling).toBe(500000);
      expect(r.employee).toBe(25000);
      expect(r.employer).toBe(50000);
      // Below the ceiling the real gross is the base.
      expect(computeNssf(400000, capped).base).toBe(400000);
    });

    it('reads rates declared as a single-element array of objects', () => {
      const r = computeNssf(1000000, nssf({ rates: [{ employee: 0.1, employer: 0.2 }] }));
      expect(r.employee).toBe(100000);
      expect(r.employer).toBe(200000);
    });

    it('treats a zero gross as zero contribution', () => {
      const r = computeNssf(0, nssf());
      expect(r.employee).toBe(0);
      expect(r.employer).toBe(0);
    });

    describe('employment scope', () => {
      // NSSF is owed once, through the employment the member is enrolled
      // under, so a rule that names "primary" must not deduct again on a
      // second employment. The marker is configuration, not a code branch.
      const primaryOnly = nssf({
        limits: { monthly_ceiling: 0, applies_to_employment: ['primary'] },
      });

      it('withholds nothing from an employment the rule does not name', () => {
        const r = computeNssf(3000000, primaryOnly, { scope: 'secondary' });
        expect(r.employee).toBe(0);
        expect(r.employer).toBe(0);
        expect(r.base).toBe(0);
        expect(r.ceiling).toBeNull();
      });

      it('still withholds on the employment the rule names', () => {
        expect(computeNssf(3000000, primaryOnly, { scope: 'primary' }).employee).toBe(150000);
      });

      it('applies to every employment when no scope is configured', () => {
        expect(computeNssf(3000000, nssf(), { scope: 'primary' }).employee).toBe(150000);
        expect(computeNssf(3000000, nssf(), { scope: 'secondary' }).employee).toBe(150000);
      });

      it('ignores the marker when the caller names no employment', () => {
        expect(computeNssf(3000000, primaryOnly).employee).toBe(150000);
      });

      it('treats a rule naming both employments as un-narrowed', () => {
        const both = nssf({
          limits: { monthly_ceiling: 0, applies_to_employment: ['primary', 'secondary'] },
        });
        expect(computeNssf(3000000, both, { scope: 'secondary' }).employee).toBe(150000);
      });
    });

    it('resolves the seeded NSSF rule', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'NSSF', { effectiveDate: '2027-01-15' });
      expect(cfg.code).toBe('UG-NSSF-2023');
      const r = computeNssf(3000000, cfg);
      expect(r.employee).toBe(150000);
      expect(r.employer).toBe(300000);
    });
  });

  describe('LST', () => {
    it('charges nothing without a configuration', () => {
      expect(computeLst(1000000, null)).toBe(0);
    });

    it('honours the apply_to_payroll opt-out', () => {
      const cfg = config({ category: 'LST', limits: { apply_to_payroll: false, monthly_amount: 5000 } });
      expect(computeLst(1000000, cfg)).toBe(0);
    });

    it('skips employees below the minimum chargeable gross', () => {
      const cfg = config({ category: 'LST', limits: { apply_to_payroll: true, min_gross: 100000, monthly_amount: 5000 } });
      expect(computeLst(50000, cfg)).toBe(0);
      expect(computeLst(100000, cfg)).toBe(5000);
    });

    it('applies a flat monthly amount', () => {
      const cfg = config({ category: 'LST', limits: { apply_to_payroll: true, min_gross: 100000, monthly_amount: 5000 } });
      expect(computeLst(5000000, cfg)).toBe(5000);
    });

    it('falls back to a percentage when no flat amount is configured', () => {
      const cfg = config({ category: 'LST', limits: { apply_to_payroll: true }, rates: { rate: 1 } });
      expect(computeLst(1000000, cfg)).toBe(10000);
    });

    describe('graduated schedule (KCCA)', () => {
      const cfg = config({
        category: 'LST',
        code: 'TEST-LST-BANDS',
        limits: {
          apply_to_payroll: true,
          min_gross: 100000,
          bands: [
            { max: 200000, monthly_amount: 1250 },
            { max: 300000, monthly_amount: 2500 },
            { max: 400000, monthly_amount: 5000 },
            { max: 600000, monthly_amount: 10000 },
            { max: 1000000, monthly_amount: 20000 },
            { max: null, monthly_amount: 25000 },
          ],
        },
      });

      it('charges the first band whose ceiling covers the gross', () => {
        expect(computeLst(150000, cfg)).toBe(1250);
        expect(computeLst(200000, cfg)).toBe(1250);
        expect(computeLst(250000, cfg)).toBe(2500);
        expect(computeLst(900000, cfg)).toBe(20000);
        expect(computeLst(5000000, cfg)).toBe(25000);
      });

      it('still respects the minimum chargeable gross', () => {
        expect(computeLst(99999, cfg)).toBe(0);
      });

      it('sorts bands so an out-of-order schedule cannot mischarge', () => {
        const shuffled = config({
          category: 'LST',
          limits: { apply_to_payroll: true, bands: [{ max: null, monthly_amount: 25000 }, { max: 200000, monthly_amount: 1250 }] },
        });
        expect(computeLst(150000, shuffled)).toBe(1250);
        expect(computeLst(250000, shuffled)).toBe(25000);
      });
    });

    describe('collection-month gate', () => {
      const cfg = config({
        category: 'LST',
        limits: { apply_to_payroll: true, min_gross: 100000, months: [7, 8, 9, 10], bands: [{ max: null, monthly_amount: 25000 }] },
      });

      it('charges inside a declared collection month', () => {
        expect(computeLst(1000000, cfg, { periodStart: '2027-07-01', periodEnd: '2027-07-31' })).toBe(25000);
        expect(computeLst(1000000, cfg, { periodStart: '2027-10-01', periodEnd: '2027-10-31' })).toBe(25000);
      });

      it('charges nothing outside the declared collection months', () => {
        expect(computeLst(1000000, cfg, { periodStart: '2027-11-01', periodEnd: '2027-11-30' })).toBe(0);
        expect(computeLst(1000000, cfg, { periodStart: '2027-12-01', periodEnd: '2027-12-31' })).toBe(0);
        expect(computeLst(1000000, cfg, { periodStart: '2027-01-01', periodEnd: '2027-01-31' })).toBe(0);
      });

      it('charges when a period straddles a collection month', () => {
        expect(computeLst(1000000, cfg, { periodStart: '2027-10-15', periodEnd: '2027-11-14' })).toBe(25000);
      });

      it('does not gate when no period is supplied', () => {
        expect(computeLst(1000000, cfg)).toBe(25000);
      });
    });

    it('uses the seeded KCCA schedule for this company', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'LST', { effectiveDate: '2027-07-15', companyId: 2 });
      expect(cfg.code).toBe('UG-LST-KCCA');
      expect(computeLst(1500000, cfg, { periodStart: '2027-07-01', periodEnd: '2027-07-31' })).toBe(25000);
      // The KCCA schedule only collects in Jul-Oct.
      expect(computeLst(1500000, cfg, { periodStart: '2027-11-01', periodEnd: '2027-11-30' })).toBe(0);
    });
  });

  describe('secondary-employment PAYE', () => {
    // Income from a second employment is withheld at a fixed rate instead of
    // the resident progressive bands. The Act publishes no numbered schedule
    // for that case, so the rate is configuration; these tests pin how that
    // configuration is read rather than any particular rate.
    const flat = (rate: number, limits: Record<string, unknown> = { apply_to_payroll: true, min_gross: 0 }) =>
      config({ category: 'PAYE_SECONDARY', code: 'TEST-PAYE-SECONDARY', rates: { rate }, limits });

    it('charges nothing without a configuration', () => {
      expect(computeSecondaryPaye(1000000, null)).toBe(0);
    });

    it('withholds the configured share of chargeable income', () => {
      expect(computeSecondaryPaye(1000000, flat(40))).toBe(400000);
      expect(computeSecondaryPaye(250000, flat(40))).toBe(100000);
    });

    it('reads a one-element array of rate objects, like the seeded row', () => {
      const cfg = config({
        category: 'PAYE_SECONDARY',
        rates: [{ rate: 40 }],
        limits: { apply_to_payroll: true, min_gross: 0 },
      });
      expect(computeSecondaryPaye(1000000, cfg)).toBe(400000);
    });

    it('honours the apply_to_payroll opt-out', () => {
      expect(computeSecondaryPaye(1000000, flat(40, { apply_to_payroll: false }))).toBe(0);
    });

    it('skips employees below the minimum chargeable income', () => {
      const cfg = flat(40, { apply_to_payroll: true, min_gross: 500000 });
      expect(computeSecondaryPaye(400000, cfg)).toBe(0);
      expect(computeSecondaryPaye(500000, cfg)).toBe(200000);
    });

    it('charges nothing at a zero or missing rate', () => {
      expect(computeSecondaryPaye(1000000, flat(0))).toBe(0);
      expect(computeSecondaryPaye(1000000, config({ category: 'PAYE_SECONDARY', limits: { apply_to_payroll: true } }))).toBe(0);
    });

    it('never goes negative', () => {
      expect(computeSecondaryPaye(0, flat(40))).toBe(0);
      expect(computeSecondaryPaye(-5000, flat(40))).toBe(0);
    });

    it('rounds to two decimals', () => {
      expect(computeSecondaryPaye(333333, flat(40))).toBe(133333.2);
    });

    it('uses the seeded rule for this tenant', async () => {
      const cfg = await requireStatutoryConfig(client, CTX, 'PAYE_SECONDARY', { effectiveDate: '2027-07-15' });
      expect(cfg.code).toBe('UG-PAYE-SECONDARY-2026');
      // Seeded at the 40% top-rate treatment pending URA confirmation.
      expect(computeSecondaryPaye(1000000, cfg)).toBe(400000);
    });
  });

  describe('employment scope', () => {
    // The marker is what keeps "first employment" and "second employment" out
    // of the engine: a rule declares where it belongs and the caller says which
    // employment it is computing for.
    const marked = (value: unknown) =>
      config({ category: 'NSSF', code: 'TEST-SCOPE', limits: { applies_to_employment: value } });

    it('reads a single scope, an array, and mixed case', () => {
      expect(employmentScopes(marked('primary'))).toEqual(['primary']);
      expect(employmentScopes(marked(['SECONDARY']))).toEqual(['secondary']);
      expect(employmentScopes(marked(['primary', 'secondary', 'primary']))).toEqual(['primary', 'secondary']);
    });

    it('treats a missing, blank or empty marker as every employment', () => {
      for (const value of [undefined, null, '', []]) {
        const cfg = marked(value);
        expect(employmentScopes(cfg)).toEqual([]);
        expect(appliesToEmployment(cfg, 'primary')).toBe(true);
        expect(appliesToEmployment(cfg, 'secondary')).toBe(true);
      }
      expect(appliesToEmployment(config({}), 'secondary')).toBe(true);
      expect(appliesToEmployment(null, 'secondary')).toBe(true);
    });

    it('narrows to the named employments only', () => {
      const cfg = marked(['secondary']);
      expect(appliesToEmployment(cfg, 'secondary')).toBe(true);
      expect(appliesToEmployment(cfg, 'primary')).toBe(false);
    });

    it('ignores an unrecognised entry rather than widening the rule', () => {
      expect(employmentScopes(marked(['primary', 'tertiary']))).toEqual(['primary']);
    });

    it('is declared on the seeded NSSF and secondary PAYE rules', async () => {
      const nssfCfg = await requireStatutoryConfig(client, CTX, 'NSSF', { effectiveDate: '2027-01-15' });
      // NSSF is deducted once, through the enrolled employment.
      expect(appliesToEmployment(nssfCfg, 'primary')).toBe(true);
      expect(appliesToEmployment(nssfCfg, 'secondary')).toBe(false);

      const secondCfg = await requireStatutoryConfig(client, CTX, 'PAYE_SECONDARY', { effectiveDate: '2027-07-15' });
      expect(appliesToEmployment(secondCfg, 'secondary')).toBe(true);
      expect(appliesToEmployment(secondCfg, 'primary')).toBe(false);
    });
  });

  describe('secondary-employment PAYE configuration', () => {
    // The rule has three legal shapes and the settings screen writes whichever
    // one was picked. These pin what each shape stores, and that an unusable or
    // contradictory one is refused before it can reach a payslip.
    it('stores a graduated band schedule, ordered from the bottom up', () => {
      const p = prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: {},
        limits: {
          apply_to_payroll: true,
          applies_to_employment: ['secondary'],
          bands: [{ max: null, monthly_amount: 120000 }, { max: 410000, monthly_amount: 50000 }],
        },
      });
      const limits = p.limits as Record<string, unknown>;
      expect(limits.bands).toEqual([
        { max: 410000, monthly_amount: 50000 },
        { max: null, monthly_amount: 120000 },
      ]);
      expect(limits.applies_to_employment).toEqual(['secondary']);
    });

    it('stores a flat monthly amount and warns that the rate is ignored', () => {
      const p = prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: { rate: 40 },
        limits: { apply_to_payroll: true, monthly_amount: 75000 },
      });
      const limits = p.limits as Record<string, unknown>;
      expect(limits.monthly_amount).toBe(75000);
      expect(limits.bands).toBeUndefined();
      expect(p.warnings.join(' ')).toMatch(/rates\.rate is ignored/);
    });

    it('stores a percentage of chargeable income', () => {
      const p = prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: { rate: 40 },
        limits: { apply_to_payroll: true },
      });
      expect((p.rates as Record<string, unknown>).rate).toBe(40);
      expect((p.limits as Record<string, unknown>).bands).toBeUndefined();
    });

    it('refuses a schedule that declares no shape at all', () => {
      expect(() => prepareStatutoryConfig('PAYE_SECONDARY', { rates: {}, limits: {} }))
        .toThrow(/needs one of: limits\.bands, limits\.monthly_amount, or rates\.rate/);
    });

    it('refuses a percentage outside 0-100', () => {
      expect(() => prepareStatutoryConfig('PAYE_SECONDARY', { rates: { rate: 140 }, limits: {} }))
        .toThrow(/between 0 and 100/);
    });

    it('refuses a scope that is not an employment', () => {
      expect(() => prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: { rate: 40 },
        limits: { applies_to_employment: ['secondary', 'tertiary'] },
      })).toThrow(/applies_to_employment must be primary or secondary \(got tertiary\)/);
    });

    it('drops a blank scope instead of storing an empty one', () => {
      const p = prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: { rate: 40 },
        limits: { applies_to_employment: [] },
      });
      expect((p.limits as Record<string, unknown>).applies_to_employment).toBeUndefined();
    });

    it('warns when the scope names every employment, which narrows nothing', () => {
      const p = prepareStatutoryConfig('PAYE_SECONDARY', {
        rates: { rate: 40 },
        limits: { applies_to_employment: ['primary', 'secondary'] },
      });
      expect(p.warnings.join(' ')).toMatch(/does not narrow/);
    });

    it('keeps the scope declaration when validating an NSSF table', () => {
      const p = prepareStatutoryConfig('NSSF', {
        rates: { employee: 0.05, employer: 0.1 },
        limits: { monthly_ceiling: 0, applies_to_employment: ['primary'] },
      });
      expect((p.limits as Record<string, unknown>).applies_to_employment).toEqual(['primary']);
    });

    it('routes PAYE_SECONDARY through its own shape check, not the generic one', () => {
      // A generic table accepts any shape; the secondary schedule refuses an
      // empty one, so meeting that refusal proves the dispatch is wired up.
      expect(() => prepareStatutoryConfig('PAYE_SECONDARY', { rates: {}, limits: {} })).toThrow();
      expect(() => prepareStatutoryConfig('LEVY', { rates: {}, limits: {} })).not.toThrow();
    });
  });

  describe('statutory filing workflow', () => {
    const LST_PERIOD = { start: '2027-10-01', end: '2027-10-31' };
    const NSSF_PERIOD = { start: '2027-10-01', end: '2027-10-31' };

    const filing = (body: Record<string, unknown>) =>
      createStatutoryFiling(client, CTX, {
        category: 'LST',
        periodStart: LST_PERIOD.start,
        periodEnd: LST_PERIOD.end,
        ...(body as { category: string; periodStart: string; periodEnd: string }),
      });

    // Each filing owns the (category, period) pair the unique index guards, so a
    // test that fails midway must not leave a row behind and cascade a
    // duplicate-key error into every later test.
    afterEach(async () => {
      await db(`DELETE FROM statutory_submissions WHERE period_start >= '2027-10-01'`);
    });

    it('rejects an impossible or unknown filing', async () => {
      await expect(filing({ periodStart: '2027-10-31', periodEnd: '2027-10-01' }))
        .rejects.toThrow(/cannot be before its start/);
      await expect(filing({ category: 'BOGUS' }))
        .rejects.toThrow(/Unknown statutory category/);
      await expect(filing({ periodStart: '', periodEnd: '' }))
        .rejects.toThrow(/needs a period start and end date/);
    });

    it('runs PENDING to PAID with a full audit trail', async () => {
      const created = await filing({});
      expect(created.filing.status).toBe('PENDING');
      expect(created.filing.category).toBe('LST');
      expect(created.filing.currency).toBe('UGX');
      // The rule version that governed the period is captured on the return.
      expect(created.filing.statutoryConfigId).toBeTruthy();
      const id = Number(created.filing.id);

      const prepared = await prepareStatutoryFiling(client, CTX, id, { dueDate: '2027-11-15' });
      expect(prepared.filing.status).toBe('PREPARED');
      expect(prepared.filing.dueDate).toBe('2027-11-15');

      const submitted = await submitStatutoryFiling(client, CTX, id, { filingNo: `LST-${id}` });
      expect(submitted.filing.status).toBe('SUBMITTED');
      expect(submitted.filing.declared).toBe(true);
      expect(submitted.filing.filingNo).toBe(`LST-${id}`);

      // Give the return a real liability: an empty return would make the
      // reconciliation arithmetic meaningless.
      await db(
        `UPDATE statutory_submissions SET gross_amount = $2, employee_contribution = $3, employer_contribution = $4 WHERE id = $1`,
        [id, 9000000, 100000, 200000]
      );

      const accepted = await acceptStatutoryFiling(client, CTX, id, { filingNo: `LST-${id}` });
      expect(accepted.filing.status).toBe('ACCEPTED');
      expect(accepted.filing.declaredTotal).toBe(300000);

      const paid = await recordStatutoryPayment(client, CTX, id, {
        paymentDate: '2027-11-14',
        paymentReference: 'PRN-1',
        amount: 300000,
      });
      expect(paid.filing.status).toBe('PAID');
      expect(paid.filing.settledTotal).toBe(300000);
      expect(paid.filing.variance).toBe(0);
      expect(paid.filing.outstanding).toBe(0);
      expect(paid.reconciliation.reconciled).toBe(true);

      // Every transition left an audit row.
      expect(paid.history.length).toBeGreaterThanOrEqual(5);
      expect(paid.history.map((h) => String(h.action))).toEqual(
        expect.arrayContaining(['create', 'prepare', 'submit', 'accept', 'pay'])
      );

      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('refuses a duplicate return for the same obligation and period', async () => {
      const first = await filing({});
      const id = Number(first.filing.id);
      await expect(filing({})).rejects.toMatchObject({ status: 409 });
      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
      await db(`DELETE FROM statutory_submissions WHERE period_start = $1 AND category = 'LST'`, [LST_PERIOD.start]);
    });

    it('records a shortfall instead of letting it disappear', async () => {
      const created = await filing({});
      const id = Number(created.filing.id);
      await db(
        `UPDATE statutory_submissions SET employee_contribution = $2, employer_contribution = $3 WHERE id = $1`,
        [id, 100000, 200000]
      );
      const reconciled = await reconcileStatutoryFiling(client, CTX, id, { reconciledAmount: 250000 });
      expect(reconciled.filing.status).toBe('PENDING');
      expect(reconciled.filing.declaredTotal).toBe(300000);
      expect(reconciled.filing.settledTotal).toBe(250000);
      expect(reconciled.filing.variance).toBe(50000);
      expect(reconciled.filing.outstanding).toBe(50000);
      expect(reconciled.reconciliation.reconciled).toBe(false);
      // The variance is persisted, not merely displayed.
      const stored = await db(`SELECT variance_amount FROM statutory_submissions WHERE id = $1`, [id]);
      expect(Number(stored.rows[0].variance_amount)).toBe(50000);
      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('rejects a negative or nonsensical settlement', async () => {
      const created = await filing({});
      const id = Number(created.filing.id);
      await expect(recordStatutoryPayment(client, CTX, id, { amount: -1 }))
        .rejects.toThrow(/must be a positive number/);
      await expect(reconcileStatutoryFiling(client, CTX, id, { reconciledAmount: -5 }))
        .rejects.toThrow(/must be a positive number/);
      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('refuses an illegal transition', async () => {
      const created = await filing({});
      const id = Number(created.filing.id);
      // A PENDING return cannot be accepted; it has not been submitted yet.
      await expect(acceptStatutoryFiling(client, CTX, id))
        .rejects.toMatchObject({ status: 409 });
      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('requires a written reason to cancel, and blocks a cancelled return', async () => {
      const created = await filing({ category: 'NSSF', periodStart: NSSF_PERIOD.start, periodEnd: NSSF_PERIOD.end });
      const id = Number(created.filing.id);
      expect(created.filing.category).toBe('NSSF');

      await expect(cancelStatutoryFiling(client, CTX, id, { reason: 'oops' }))
        .rejects.toThrow(/at least 10 characters/);

      const cancelled = await cancelStatutoryFiling(client, CTX, id, { reason: 'Duplicate return raised in error' });
      expect(cancelled.filing.status).toBe('CANCELLED');

      await expect(cancelStatutoryFiling(client, CTX, id, { reason: 'Cancelling a second time now' }))
        .rejects.toMatchObject({ status: 409 });
      await expect(reconcileStatutoryFiling(client, CTX, id, { reconciledAmount: 1000 }))
        .rejects.toMatchObject({ status: 409 });
      await expect(recordStatutoryPayment(client, CTX, id, { amount: 1000 }))
        .rejects.toMatchObject({ status: 409 });

      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('is scoped to the tenant and company', async () => {
      const created = await filing({});
      const id = Number(created.filing.id);
      await expect(getStatutoryFiling(client, { tenantId: 2, companyId: 9999, userId: 15 }, id))
        .rejects.toMatchObject({ status: 404 });
      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });

    it('lists filings and rolls them into the compliance board', async () => {
      const created = await filing({});
      const id = Number(created.filing.id);

      const listed = await listStatutoryFilings(client, CTX, { category: 'LST', pageSize: 5 });
      expect(listed.items.some((f) => Number(f.id) === id)).toBe(true);

      const overdue = await listStatutoryFilings(client, CTX, { overdueOnly: true });
      expect(overdue.items.every((f) => !['PAID', 'CANCELLED'].includes(String(f.status)))).toBe(true);

      const search = await listStatutoryFilings(client, CTX, { q: 'LST' });
      expect(search.items.length).toBeGreaterThan(0);

      await db(`DELETE FROM statutory_submissions WHERE id = $1`, [id]);
    });
  });
});
