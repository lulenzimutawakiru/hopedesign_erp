-- ============================================================
-- 0071 Asset maintenance: inventory parts reservation + GL link
-- (HOPE DESIGN GROUP LTD)
-- 1. asset_maintenance_parts.reservation_id links a work-order
--    part to the inventory reservation created for it.
-- 2. asset_maintenance_work_orders.gl_journal_id records the
--    finance journal entry posting the maintenance cost.
-- Idempotent: safe to re-apply.
-- ============================================================

ALTER TABLE asset_maintenance_parts
  ADD COLUMN IF NOT EXISTS reservation_id BIGINT REFERENCES inventory_reservations(id);
CREATE INDEX IF NOT EXISTS idx_asset_maint_parts_reservation ON asset_maintenance_parts(reservation_id);

ALTER TABLE asset_maintenance_work_orders
  ADD COLUMN IF NOT EXISTS gl_journal_id BIGINT REFERENCES journal_entries(id);
CREATE INDEX IF NOT EXISTS idx_asset_mwo_journal ON asset_maintenance_work_orders(gl_journal_id);
