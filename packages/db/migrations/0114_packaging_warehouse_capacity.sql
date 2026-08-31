-- ============================================================================
-- PACK-WH capacity raised to 60,000 (stock moved in is ~51,000 units).
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

UPDATE warehouses SET capacity_qty = 60000
WHERE code = 'PACK-WH';

UPDATE warehouse_bins SET capacity_qty = 60000
WHERE code = 'BIN-01'
  AND warehouse_id IN (SELECT id FROM warehouses WHERE code = 'PACK-WH');