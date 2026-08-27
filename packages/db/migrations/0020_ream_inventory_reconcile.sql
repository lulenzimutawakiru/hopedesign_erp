-- 0020_ream_inventory_reconcile.sql
-- One-time reconciliation for the Ream Packing flow.
--   1) Backfill PRODUCTION_OUTPUT stock layers for reams generated before
--      inventory posting existed (batched reams only).
--   2) Backfill ISSUE stock layers for sealed cartons that never posted one.
--   3) Reconcile product_batches.quantity to live on-hand so the Batches
--      register matches the Stock board and the packing ledger.

DO $$
DECLARE
  v RECORD;
  v_wh BIGINT;
  v_bin BIGINT;
BEGIN
  FOR v IN
    SELECT r.id AS ream_id, r.ream_no, r.company_id, r.tenant_id, r.product_id,
           r.batch_id, r.qr_id, r.created_by,
           COALESCE(p.standard_cost, 0)::numeric AS unit_cost
    FROM reams r
    JOIN products p ON p.id = r.product_id
    WHERE r.batch_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.reference_type = 'reams' AND m.reference_id = r.id
      )
    ORDER BY r.id
  LOOP
    SELECT w.id,
           (SELECT b.id FROM warehouse_bins b WHERE b.warehouse_id = w.id ORDER BY b.code LIMIT 1)
      INTO v_wh, v_bin
      FROM warehouses w
      WHERE w.company_id = v.company_id AND w.code = 'FG-WH';
    IF v_wh IS NOT NULL THEN
      PERFORM post_inventory_move(
        v.company_id, v.tenant_id, NULL, 'PRODUCTION_OUTPUT',
        v.product_id, v.batch_id, v_wh, v_bin,
        NULL, NULL, NULL, NULL,
        1, v.unit_cost, 'reams', v.ream_id, v.ream_no, v.qr_id, NULL, v.created_by,
        'Ream ' || v.ream_no || ' generated'
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  v RECORD;
  v_wh BIGINT;
  v_bin BIGINT;
  v_avail NUMERIC;
BEGIN
  FOR v IN
    SELECT c.id AS carton_id, c.carton_no, c.company_id, c.tenant_id, c.product_id,
           c.batch_id, c.qr_id, c.created_by, c.ream_count,
           COALESCE(p.standard_cost, 0)::numeric AS unit_cost
    FROM cartons c
    JOIN products p ON p.id = c.product_id
    WHERE c.batch_id IS NOT NULL AND c.status = 'SEALED'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.reference_type = 'cartons' AND m.reference_id = c.id
      )
    ORDER BY c.id
  LOOP
    SELECT w.id,
           (SELECT b.id FROM warehouse_bins b WHERE b.warehouse_id = w.id ORDER BY b.code LIMIT 1)
      INTO v_wh, v_bin
      FROM warehouses w
      WHERE w.company_id = v.company_id AND w.code = 'FG-WH';
    IF v_wh IS NOT NULL THEN
      SELECT COALESCE(SUM(i.quantity), 0) INTO v_avail
      FROM inventory i
      WHERE i.company_id = v.company_id AND i.product_id = v.product_id
        AND i.batch_id IS NOT DISTINCT FROM v.batch_id
        AND i.warehouse_id = v_wh AND i.bin_id IS NOT DISTINCT FROM v_bin;
      IF v_avail >= COALESCE(v.ream_count, 5) THEN
        PERFORM post_inventory_move(
          v.company_id, v.tenant_id, NULL, 'ISSUE',
          v.product_id, v.batch_id, v_wh, v_bin,
          NULL, NULL, NULL, NULL,
          COALESCE(v.ream_count, 5), v.unit_cost, 'cartons', v.carton_id, v.carton_no,
          v.qr_id, NULL, v.created_by,
          'Carton ' || v.carton_no || ' sealed (' || COALESCE(v.ream_count, 5) || ' reams packed)'
        );
      END IF;
    END IF;
  END LOOP;
END $$;

-- Reconcile master-data quantity with live on-hand (per batch across all
-- warehouses/bins) so the Batches register matches the Stock board.
UPDATE product_batches pb
SET quantity = COALESCE(s.onhand, 0),
    updated_at = now()
FROM (
  SELECT batch_id, SUM(quantity)::numeric AS onhand
  FROM inventory
  GROUP BY batch_id
) s
WHERE s.batch_id = pb.id;