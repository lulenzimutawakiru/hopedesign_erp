-- ============================================================
-- 0031 User default lead time
-- Each requester has a planning lead time (days) used to derive
-- the default "Required By" date on purchase requisitions:
--   required_by_date = org business date + default_lead_days
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_lead_days INT NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_default_lead_days') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_default_lead_days CHECK (default_lead_days > 0);
  END IF;
END $$;

-- Procurement Manager: 14-day planning lead time for the demo tenant.
UPDATE users
SET default_lead_days = 14
WHERE id = 18 AND tenant_id = 2 AND default_lead_days = 7;
