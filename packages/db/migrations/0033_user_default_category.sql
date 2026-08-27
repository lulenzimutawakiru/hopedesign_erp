-- ============================================================
-- 0033 User default procurement category
-- Each requester has a default category (GOODS / SERVICES /
-- ASSETS / SUBSCRIPTION / OTHER) that prefills new purchase
-- requisitions.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_procurement_category TEXT NOT NULL DEFAULT 'GOODS';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_default_procurement_category') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_default_procurement_category
      CHECK (default_procurement_category IN ('GOODS', 'SERVICES', 'ASSETS', 'SUBSCRIPTION', 'OTHER'));
  END IF;
END $$;

-- Procurement Manager: services default for the demo tenant.
UPDATE users
SET default_procurement_category = 'SERVICES'
WHERE id = 18 AND tenant_id = 2 AND default_procurement_category = 'GOODS';
