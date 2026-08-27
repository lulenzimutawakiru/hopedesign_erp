-- ============================================================
-- 0037 User default currency
-- Default currency code prefilled on new purchase requisitions.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_currency_code TEXT;

-- Procurement Manager: default currency for the demo tenant.
UPDATE users
SET default_currency_code = 'UGX'
WHERE id = 18 AND tenant_id = 2 AND default_currency_code IS NULL;
