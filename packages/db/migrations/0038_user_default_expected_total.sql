-- ============================================================
-- 0038 User default expected total value
-- Sanctioned spend target (base currency) prefilled/displayed
-- on new purchase requisitions for budget validation.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_expected_total NUMERIC(18,2);

-- Procurement Manager: expected total for the demo tenant (UGX).
UPDATE users
SET default_expected_total = 25000000
WHERE id = 18 AND tenant_id = 2 AND default_expected_total IS NULL;
