-- ============================================================
-- 0032 User default priority
-- Each requester has a default PR priority (LOW/NORMAL/HIGH/
-- CRITICAL) that prefills new purchase requisitions.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_priority TEXT NOT NULL DEFAULT 'NORMAL';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_default_priority') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_default_priority
      CHECK (default_priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL'));
  END IF;
END $$;

-- Procurement Manager: high-priority default for the demo tenant.
UPDATE users
SET default_priority = 'HIGH'
WHERE id = 18 AND tenant_id = 2 AND default_priority = 'NORMAL';
