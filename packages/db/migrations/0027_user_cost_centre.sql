-- ============================================================
-- 0027 User cost centre
-- Gives each user a default cost centre so requisitions and
-- expense documents can prefill the charging cost centre.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cost_centre_id BIGINT REFERENCES cost_centres(id);

CREATE INDEX IF NOT EXISTS idx_users_cost_centre
  ON users (cost_centre_id);

-- Procurement & Supply cost centre for tenant/company 2 (idempotent).
INSERT INTO cost_centres (company_id, tenant_id, code, name, description, status)
SELECT 2, 2, 'CC-PROC', 'Procurement & Supply', 'Procurement and supply chain operations', 'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1 FROM cost_centres WHERE company_id = 2 AND tenant_id = 2 AND code = 'CC-PROC'
);

-- Default cost centre for the Procurement Manager.
UPDATE users u
SET cost_centre_id = cc.id
FROM cost_centres cc
WHERE u.id = 18
  AND u.tenant_id = 2
  AND u.cost_centre_id IS NULL
  AND cc.tenant_id = 2
  AND cc.company_id = 2
  AND cc.code = 'CC-PROC';
