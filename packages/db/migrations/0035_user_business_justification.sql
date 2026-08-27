-- ============================================================
-- 0035 User default business justification + PR header field
-- Business justification is the cost-benefit/strategic rationale
-- captured on every purchase requisition for approval review.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_business_justification TEXT;

ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS business_justification TEXT;

-- Procurement Manager: default justification for the demo tenant.
UPDATE users
SET default_business_justification = 'Cost-benefit reviewed; procurement is required for operational continuity and is within the approved budget.'
WHERE id = 18 AND tenant_id = 2 AND default_business_justification IS NULL;
