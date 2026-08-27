-- ============================================================
-- 0026 User requesting location
-- Gives each user an explicit default requesting/delivery
-- location (warehouse) so purchase requisitions can prefill
-- the receiving warehouse for the requester.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS requesting_location_id BIGINT REFERENCES warehouses(id);

CREATE INDEX IF NOT EXISTS idx_users_requesting_location
  ON users (requesting_location_id);

-- Default requesting location for the Procurement Manager
-- (tenant/company 2): the branch RAW-MAT receiving store.
UPDATE users u
SET requesting_location_id = w.id
FROM warehouses w
WHERE u.id = 18
  AND u.tenant_id = 2
  AND u.requesting_location_id IS NULL
  AND w.tenant_id = 2
  AND w.branch_id = 2
  AND w.code = 'RAW-MAT';
