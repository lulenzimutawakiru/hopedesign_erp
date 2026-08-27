-- ============================================================
-- 0036 User default delivery location
-- Default delivery/ship-to location prefilled on new PRs.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_delivery_location TEXT;

-- Procurement Manager: default delivery location for the demo tenant.
UPDATE users
SET default_delivery_location = 'Kampala Plant - Raw Materials Store (RAW-MAT)'
WHERE id = 18 AND tenant_id = 2 AND default_delivery_location IS NULL;
