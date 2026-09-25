-- 0189_secondary_employment_paye.sql
-- Secondary-employment PAYE (Uganda) and the employee mark that selects it.
--
-- The Income Tax (Amendment) Act, 2026 keeps a distinct treatment for income
-- earned from more than one employment relationship: the secondary employer
-- withholds PAYE at a fixed rate rather than on the resident progressive
-- bands. The ordinary PAYE table cannot express that case, and there was no
-- field on an employee to say "this is a second employment".
--
-- This migration does three additive things:
--   1. marks an employee as being on secondary employment;
--   2. admits PAYE_SECONDARY to the statutory category check;
--   3. seeds the tenant-wide PAYE_SECONDARY rule the payroll engine resolves
--      for those employees.
--
-- The Act does not publish a numbered secondary-employment schedule, so the
-- rate is configuration rather than code: it is seeded at 40% (the top-rate
-- treatment the Act refers to for secondary employment) and is intended to be
-- confirmed against URA guidance and edited in Payroll Settings. A tenant that
-- has not adopted the rule keeps using the resident bands: the engine treats an
-- absent PAYE_SECONDARY config as "no secondary schedule".
--
-- Idempotent: the column uses ADD ... IF NOT EXISTS and the seed is guarded by
-- NOT EXISTS on the shipped code, matching the 0188 idiom. statutory_configs
-- carries no unique constraint, so ON CONFLICT is not available.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Which employees are on a second employment
-- ---------------------------------------------------------------------------
-- A dedicated flag, not employment_type: that column is the contract type
-- (PERMANENT/CONTRACT/...), and secondary employment is a fact about the
-- employee's other employers, which can coincide with any contract type.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_secondary_employment BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Admit the new category
-- ---------------------------------------------------------------------------
-- statutory_configs.category carries a CHECK created with the table in 0023,
-- which enumerates the categories the schema knew then. PAYE_SECONDARY is new,
-- so the check has to be widened before the seed below can insert.
ALTER TABLE statutory_configs
  DROP CONSTRAINT IF EXISTS statutory_configs_category_check;
ALTER TABLE statutory_configs
  ADD CONSTRAINT statutory_configs_category_check
  CHECK (category IN ('PAYE','PAYE_SECONDARY','NSSF','LST','SDI','WHT','SEVERANCE','MINIMUM_WAGE','OTHER'));

-- ---------------------------------------------------------------------------
-- 3. The secondary-employment PAYE schedule
-- ---------------------------------------------------------------------------
-- rates.rate is a percentage (40 = 40%), matching the form computeSecondaryPaye
-- reads. limits.apply_to_payroll lets a tenant switch the rule off without
-- deleting it; limits.min_gross is an optional monthly floor.
INSERT INTO statutory_configs
  (company_id, tenant_id, country, category, code, name, description,
   effective_from, effective_to, rates, thresholds, limits, formula, version, status)
SELECT NULL,
       t.tenant_id,
       'UG',
       'PAYE_SECONDARY',
       'UG-PAYE-SECONDARY-2026',
       'Uganda PAYE - secondary employment (FY2026/27)',
       'Fixed-rate withholding on income from a second employment, effective from 01 Jul 2026. Rate pending confirmation against URA guidance.',
       DATE '2026-07-01',
       NULL,
       '{"rate": 40}'::jsonb,
       '[]'::jsonb,
       '{"apply_to_payroll": true, "min_gross": 0}'::jsonb,
       NULL,
       1,
       'ACTIVE'
  FROM (SELECT DISTINCT tenant_id
          FROM statutory_configs
         WHERE category = 'PAYE'
           AND company_id IS NULL) AS t
 WHERE NOT EXISTS (
   SELECT 1
     FROM statutory_configs s
    WHERE s.tenant_id = t.tenant_id
      AND s.company_id IS NULL
      AND s.code = 'UG-PAYE-SECONDARY-2026'
 );

COMMIT;
