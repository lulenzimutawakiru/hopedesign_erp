-- ============================================================================
-- HOPE DESIGN GROUP LTD ERP
-- 0200_efris_stock_movement.sql
-- URA EFRIS stock management (T131) + purchase/B2C auto-registration gates.
--
-- EFRIS stock movement is interface code T131 (goodsStockIn / goodsStockInItem),
-- not a fiscal document: URA returns a stock acknowledgement (returnCode 00),
-- never an FDN. This migration:
--   1. Widens efris_transactions.status to accept 'ACCEPTED' (the terminal
--      state for an acknowledged stock movement).
--   2. Adds efris_transactions.accepted_at to timestamp that acknowledgement.
--   3. Adds the per-configuration auto-registration gates the service layer
--      reads: fiscalize_stock_on_post (inventory adjustments / stock-in) and
--      fiscalize_purchases_on_post (goods receipts → purchase stock-in).
--
-- Nothing here enables a gate by default: the TEST configuration is flipped on
-- explicitly by the operator, exactly like fiscalize_sales_on_post.
-- ============================================================================

-- 1. ACCEPTED status + acknowledgement timestamp on efris_transactions.
ALTER TABLE efris_transactions
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

ALTER TABLE efris_transactions
  DROP CONSTRAINT IF EXISTS efris_transactions_status_check;
ALTER TABLE efris_transactions
  ADD CONSTRAINT efris_transactions_status_check CHECK (status IN (
    'PENDING','QUEUED','PROCESSING','TRANSMITTED','ACCEPTED','FISCALIZED','FAILED',
    'RETRYING','REJECTED','CANCELLED','VOIDED'
  ));

-- 2. Auto-registration gates on efris_configurations.
ALTER TABLE efris_configurations
  ADD COLUMN IF NOT EXISTS fiscalize_stock_on_post BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE efris_configurations
  ADD COLUMN IF NOT EXISTS fiscalize_purchases_on_post BOOLEAN NOT NULL DEFAULT false;
