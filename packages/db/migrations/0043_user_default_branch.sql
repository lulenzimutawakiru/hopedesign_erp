-- ============================================================
-- 0043 User default branch + PR header branch
-- Requisitions are filed against a branch the user can access;
-- the session branch remains the default for new requisitions.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_branch_id BIGINT REFERENCES branches(id);

-- Procurement Manager: default branch for the demo tenant.
UPDATE users
SET default_branch_id = 2
WHERE id = 18 AND tenant_id = 2 AND default_branch_id IS NULL;
