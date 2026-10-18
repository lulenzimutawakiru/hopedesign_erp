-- ============================================================
-- 0196 CRM: customer edit + EFRIS verification persistence
-- ============================================================
-- Adds the EFRIS verification state to the customer account so a TIN lookup
-- outcome can be persisted at save time (review-then-save), plus an index that
-- makes normalized-TIN duplicate checks efficient.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS efris_verification TEXT
    CHECK (efris_verification IS NULL OR efris_verification IN ('VERIFIED','NOT_VERIFIED','LOOKUP_FAILED')),
  ADD COLUMN IF NOT EXISTS efris_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS efris_ref TEXT;

-- Non-unique partial index to speed up the duplicate-TIN scan in
-- findDuplicates()/lookupCustomerTin(). Deliberately non-unique: legacy data
-- may already contain duplicate TINs and the duplicate-prevention workflow
-- resolves them through review rather than a destructive constraint.
CREATE INDEX IF NOT EXISTS idx_customers_tin
  ON customers (company_id, tin)
  WHERE tin IS NOT NULL AND tin <> '';
