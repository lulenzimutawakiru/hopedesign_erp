-- ===========================================================================
-- 0224 - Product master: brand/image + maker-checker approval workflow
--
-- Adds the brand and image fields the product master was missing, and a
-- dedicated approval_status column so a product can flow through the existing
-- maker-checker workflow (DRAFT -> SUBMITTED -> APPROVED/REJECTED) without
-- conflating approval with the lifecycle `status` column (ACTIVE/INACTIVE/
-- DISCONTINUED, which filters what appears in pickers and catalogues).
--
-- Existing products default to APPROVED so nothing is hidden or re-queued on
-- upgrade; approval_status is only ever written by the workflow engine (it is
-- in PROCESS_EXCLUDED, not client-writable).
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (approval_status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_products_approval_status ON products (company_id, approval_status);
