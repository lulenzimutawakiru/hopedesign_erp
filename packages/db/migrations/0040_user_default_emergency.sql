-- ============================================================
-- 0040 User default emergency purchase flag + PR header flag
-- Marks requisitions that require urgent/expedited procurement.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_emergency_purchase BOOLEAN;

ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS emergency_purchase BOOLEAN NOT NULL DEFAULT FALSE;

-- Procurement Manager: emergency-purchase default for the demo tenant.
UPDATE users
SET default_emergency_purchase = TRUE
WHERE id = 18 AND tenant_id = 2 AND default_emergency_purchase IS NULL;
