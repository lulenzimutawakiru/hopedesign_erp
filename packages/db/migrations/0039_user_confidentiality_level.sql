-- ============================================================
-- 0039 User default confidentiality level + PR header field
-- Data classification (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED)
-- captured on every purchase requisition.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_confidentiality_level TEXT;

ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS confidentiality_level TEXT;

-- Procurement Manager: default confidentiality for the demo tenant.
UPDATE users
SET default_confidentiality_level = 'CONFIDENTIAL'
WHERE id = 18 AND tenant_id = 2 AND default_confidentiality_level IS NULL;
