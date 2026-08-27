-- Stable planned-production capacity for REAM batches.
-- post_inventory_move mutates product_batches.quantity on every movement, so
-- we anchor the batch's planned target in its own column (backfilled from the
-- current quantity for existing batches).
ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS planned_qty NUMERIC(18,4);
UPDATE product_batches SET planned_qty = quantity WHERE planned_qty IS NULL;
