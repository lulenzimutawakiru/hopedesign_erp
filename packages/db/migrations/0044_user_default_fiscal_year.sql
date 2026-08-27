-- ============================================================
-- 0044 User default fiscal year + PR fiscal year
-- Requisitions are filed against a fiscal year of the resolved
-- company; the user's fiscal year remains the default.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_fiscal_year_id BIGINT REFERENCES fiscal_years(id);

ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS fiscal_year_id BIGINT REFERENCES fiscal_years(id);

-- Procurement Manager: default fiscal year for the demo tenant.
UPDATE users
SET default_fiscal_year_id = 1
WHERE id = 18 AND tenant_id = 2 AND default_fiscal_year_id IS NULL;
