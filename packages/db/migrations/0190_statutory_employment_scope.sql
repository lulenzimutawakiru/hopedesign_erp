-- 0190_statutory_employment_scope.sql
-- Say, in configuration, which employments each statutory table governs.
--
-- The engine already knew that income from a second employment is taxed
-- differently (0189) and that NSSF is owed once, through the employment the
-- member is enrolled under. What was missing was a way for a table to declare
-- which employment it covers: the code decided that by category, so an operator
-- could not change the treatment from Payroll Settings, and the tables the
-- system shipped said nothing at all.
--
-- limits.applies_to_employment closes that gap. It holds the employments a rule
-- governs, as a list of "primary" and "secondary":
--
--   * absent or empty  -> the table applies to every employment. This is how
--                         every pre-existing row reads, so a table this
--                         migration does not name keeps behaving exactly as it
--                         did before;
--   * ["primary"]      -> primary employment only;
--   * ["secondary"]    -> second employment only.
--
-- This migration only annotates the two tables the system ships, and only
-- where the marker is not already right:
--   1. UG-NSSF-2023           -> ["primary"], so NSSF is taken once, through the
--      first employment, and an employer paying a member a second time does not
--      deduct it again;
--   2. UG-PAYE-SECONDARY-2026 -> ["secondary"], so the fixed rate applies to a
--      second employment while a first employment keeps the resident bands.
--
-- Existing keys in limits (apply_to_payroll, min_gross, monthly_ceiling, and
-- the LST and secondary-employment bands) are preserved: the marker is merged
-- in with jsonb || rather than replacing the object, and the merge is scoped by
-- code so a tenant's own tables are untouched.
--
-- Idempotent: each UPDATE is guarded so a row that already carries the marker is
-- left alone, and re-running the migration is a no-op. statutory_configs
-- carries no unique constraint, so ON CONFLICT is not available and is not
-- needed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. NSSF follows the first employment
-- ---------------------------------------------------------------------------
UPDATE statutory_configs
   SET limits = COALESCE(limits, '{}'::jsonb) || '{"applies_to_employment": ["primary"]}'::jsonb
 WHERE code = 'UG-NSSF-2023'
   AND COALESCE(limits, '{}'::jsonb) -> 'applies_to_employment' IS DISTINCT FROM '["primary"]'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. The fixed-rate PAYE table follows the second employment
-- ---------------------------------------------------------------------------
UPDATE statutory_configs
   SET limits = COALESCE(limits, '{}'::jsonb) || '{"applies_to_employment": ["secondary"]}'::jsonb
 WHERE code = 'UG-PAYE-SECONDARY-2026'
   AND COALESCE(limits, '{}'::jsonb) -> 'applies_to_employment' IS DISTINCT FROM '["secondary"]'::jsonb;

COMMIT;