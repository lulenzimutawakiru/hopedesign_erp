-- ============================================================
-- 0034 User default purpose
-- Each requester has a default purpose/justification that
-- prefills new purchase requisitions (stored in description).
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_purpose TEXT;

-- Procurement Manager: default justification for the demo tenant.
UPDATE users
SET default_purpose = 'Routine operational requirement to sustain production output and service delivery.'
WHERE id = 18 AND tenant_id = 2 AND default_purpose IS NULL;
