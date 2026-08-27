-- ============================================================
-- 0042 User default company + PR header company
-- Requisitions are filed against a company the user can access;
-- the session company remains the default for new requisitions.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_company_id BIGINT REFERENCES companies(id);

-- Procurement Manager: default company for the demo tenant.
UPDATE users
SET default_company_id = 2
WHERE id = 18 AND tenant_id = 2 AND default_company_id IS NULL;
