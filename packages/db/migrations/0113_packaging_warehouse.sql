-- ============================================================================
-- Packaging Materials Store (PACK-WH)
-- Packaging materials (cartons, ream wrappers, labels, films, adhesives,
-- pallets, strapping) move out of the raw materials store into a dedicated
-- PACKAGING-type warehouse. Smart put-away then routes PACKAGING products to
-- the right store instead of RAW-MAT. Idempotent: safe on fresh + existing DB.
-- ============================================================================

-- 1) Allow the PACKAGING warehouse type.
ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_type_check;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_type_check
  CHECK (type IN ('RAW_MATERIAL','WIP','FINISHED_GOODS','SECURE','QUARANTINE','DAMAGED','RETURNS','CONSUMABLES','SPARE_PARTS','PACKAGING','GENERAL'));

DO $$
DECLARE
  v_company  BIGINT;
  v_tenant   BIGINT;
  v_branch   BIGINT;
  v_facility BIGINT;
  v_wh       BIGINT;
  v_zone     BIGINT;
  v_rack     BIGINT;
  v_shelf    BIGINT;
BEGIN
  -- Primary HOPE DESIGN company (convention: tenant 2 / company 2).
  SELECT id, tenant_id INTO v_company, v_tenant
  FROM companies WHERE tenant_id = 2 AND id = 2 LIMIT 1;
  IF v_company IS NULL THEN
    SELECT id, tenant_id INTO v_company, v_tenant
  FROM companies ORDER BY id LIMIT 1;
  END IF;
  IF v_company IS NULL THEN RETURN; END IF;

  SELECT id INTO v_branch FROM branches WHERE company_id = v_company ORDER BY id LIMIT 1;

  SELECT id INTO v_facility FROM production_facilities WHERE company_id = v_company ORDER BY id LIMIT 1;

  SELECT id INTO v_wh FROM warehouses WHERE company_id = v_company AND code = 'PACK-WH';
  IF v_wh IS NULL THEN
    INSERT INTO warehouses (company_id, tenant_id, branch_id, facility_id, code, name, type, is_secure, capacity_qty, status)
    VALUES (v_company, v_tenant, v_branch, v_facility, 'PACK-WH', 'Packaging Materials Store', 'PACKAGING', false, 30000, 'ACTIVE')
    RETURNING id INTO v_wh;
  END IF;

  SELECT id INTO v_zone FROM warehouse_zones WHERE warehouse_id = v_wh AND code = 'Z1';
  IF v_zone IS NULL THEN
    INSERT INTO warehouse_zones (warehouse_id, code, name)
    VALUES (v_wh, 'Z1', 'Packaging Materials Store Zone 1') RETURNING id INTO v_zone;
  END IF;

  SELECT id INTO v_rack FROM warehouse_racks WHERE zone_id = v_zone AND code = 'R1';
  IF v_rack IS NULL THEN
    INSERT INTO warehouse_racks (zone_id, code) VALUES (v_zone, 'R1') RETURNING id INTO v_rack;
  END IF;

  SELECT id INTO v_shelf FROM warehouse_shelves WHERE rack_id = v_rack AND code = 'S1';
  IF v_shelf IS NULL THEN
    INSERT INTO warehouse_shelves (rack_id, code) VALUES (v_rack, 'S1') RETURNING id INTO v_shelf;
  END IF;

  INSERT INTO warehouse_bins (warehouse_id, shelf_id, code, name, barcode, is_secure, capacity_qty)
  SELECT v_wh, v_shelf, 'BIN-01', 'Packaging Materials Store Bin 1', 'BIN-PACK-01', false, 30000
  WHERE NOT EXISTS (SELECT 1 FROM warehouse_bins WHERE warehouse_id = v_wh AND code = 'BIN-01');
END $$;
