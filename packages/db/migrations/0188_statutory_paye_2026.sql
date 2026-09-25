-- 0188_statutory_paye_2026.sql
-- Uganda PAYE bands effective 1 July 2026 (FY2026/27) and the Local Service Tax
-- collection window.
--
-- The FY2026/27 PAYE schedule and the KCCA Local Service Tax schedule existed
-- only as hand-applied production rows. No migration ever installed them and
-- the seeder carried the superseded FY2023/24 bands under the UG-PAYE-2026
-- code, so a rebuilt or newly onboarded tenant database resolved the wrong PAYE
-- bands for every period from 1 July 2026, and would have levied Local Service
-- Tax in all twelve months instead of the first four of the financial year.
--
-- This migration makes both reproducible from source. Additive and idempotent:
-- it closes a still-open FY2023/24 version, inserts the FY2026/27 version where
-- a tenant is missing one, corrects a stored FY2026/27 row whose bands drift
-- from the legislated schedule, and declares the Jul-Oct collection window on
-- the stock LST rules that do not yet carry one.
--
-- Deliberately not touched: company-scoped rows, tenant-authored LST rules
-- (a rule the tenant wrote with no window means "all year" by design), and any
-- band an administrator has set on a code that is not the shipped default.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The FY2023/24 PAYE schedule stops applying on 1 July 2026
-- ---------------------------------------------------------------------------
-- Left open it still reads as current in the settings UI, and it remains the
-- resolved rule for any period before 1 Jul 2026.
UPDATE statutory_configs
   SET effective_to = DATE '2026-06-30',
       updated_at   = now()
 WHERE category = 'PAYE'
   AND code = 'UG-PAYE-2023'
   AND company_id IS NULL
   AND effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- 2. FY2026/27 PAYE bands, effective 1 July 2026
-- ---------------------------------------------------------------------------
-- Rates are percentages (20 = 20%), matching the band-object form the payroll
-- engine reads. Exempt to 335,000; 20% to 410,000; 25% to 485,000; 30% to
-- 10,000,000; 40% above with no ceiling.
INSERT INTO statutory_configs
  (company_id, tenant_id, country, category, code, name, description,
   effective_from, effective_to, rates, thresholds, limits, formula, version, status)
SELECT NULL,
       t.tenant_id,
       'UG',
       'PAYE',
       'UG-PAYE-2026',
       'Uganda PAYE (FY2026/27 rates)',
       'Monthly PAYE bands effective from 01 Jul 2026.',
       DATE '2026-07-01',
       NULL,
       v.bands,
       '[]'::jsonb,
       '{}'::jsonb,
       NULL,
       2,
       'ACTIVE'
  FROM (SELECT DISTINCT tenant_id
          FROM statutory_configs
         WHERE category = 'PAYE'
           AND company_id IS NULL) AS t
 CROSS JOIN (VALUES ('[
   {"min": 0,        "max": 335000,   "rate": 0},
   {"min": 335000,   "max": 410000,   "rate": 20},
   {"min": 410000,   "max": 485000,   "rate": 25},
   {"min": 485000,   "max": 10000000, "rate": 30},
   {"min": 10000000, "max": null,     "rate": 40}
 ]'::jsonb)) AS v(bands)
 WHERE NOT EXISTS (
   SELECT 1
     FROM statutory_configs s
    WHERE s.tenant_id = t.tenant_id
      AND s.company_id IS NULL
      AND s.code = 'UG-PAYE-2026'
 );

-- ---------------------------------------------------------------------------
-- 3. A hand-made UG-PAYE-2026 row may carry the superseded bands
-- ---------------------------------------------------------------------------
-- Correct only the shipped, tenant-wide row, and only when its bands actually
-- differ, so a re-run is a no-op and a deliberate admin edit is not overwritten
-- on every boot. Compares the (min, max, rate) triples as an ordered signature.
UPDATE statutory_configs s
   SET rates      = v.bands,
       version    = GREATEST(s.version, 2),
       updated_at = now()
  FROM (VALUES ('[
   {"min": 0,        "max": 335000,   "rate": 0},
   {"min": 335000,   "max": 410000,   "rate": 20},
   {"min": 410000,   "max": 485000,   "rate": 25},
   {"min": 485000,   "max": 10000000, "rate": 30},
   {"min": 10000000, "max": null,     "rate": 40}
 ]'::jsonb)) AS v(bands)
 WHERE s.category = 'PAYE'
   AND s.code = 'UG-PAYE-2026'
   AND s.company_id IS NULL
   AND jsonb_typeof(s.rates) = 'array'
   AND (SELECT string_agg((x ->> 'min') || ':' || COALESCE(x ->> 'max', '*') || ':' || (x ->> 'rate'),
                          ',' ORDER BY (x ->> 'min')::numeric)
          FROM jsonb_array_elements(s.rates) AS x)
       IS DISTINCT FROM
       (SELECT string_agg((x ->> 'min') || ':' || COALESCE(x ->> 'max', '*') || ':' || (x ->> 'rate'),
                          ',' ORDER BY (x ->> 'min')::numeric)
          FROM jsonb_array_elements(v.bands) AS x);

-- ---------------------------------------------------------------------------
-- 4. Local Service Tax is collected in the first four months of the FY
-- ---------------------------------------------------------------------------
-- LST is an annual tax the council collects in Jul-Oct; the engine already
-- honours limits.months, but the stock rules shipped without a window and were
-- therefore charged in every month. Scoped to the shipped codes only: a
-- tenant-authored LST rule with no window means "all year" by design, and
-- limits.months is the settings field the administrator edits.
UPDATE statutory_configs
   SET limits     = jsonb_set(limits, '{months}', '[7, 8, 9, 10]'::jsonb, true),
       updated_at = now()
 WHERE category = 'LST'
   AND code IN ('UG-LST-2023', 'UG-LST-KCCA')
   AND NOT (limits ? 'months');

COMMIT;