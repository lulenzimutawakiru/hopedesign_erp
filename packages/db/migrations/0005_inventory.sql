-- ============================================================
-- 0005 Inventory engine
-- ============================================================

CREATE TABLE inventory (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  reserved_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  avg_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  valuation_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, batch_id, warehouse_id, bin_id)
);
CREATE INDEX idx_inventory_product ON inventory(product_id);
CREATE INDEX idx_inventory_warehouse ON inventory(warehouse_id, bin_id);
CREATE INDEX idx_inventory_batch ON inventory(batch_id);

-- FIFO layers
CREATE TABLE inventory_layers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  layer_date DATE NOT NULL DEFAULT CURRENT_DATE,
  in_qty NUMERIC(18,4) NOT NULL,
  remaining_qty NUMERIC(18,4) NOT NULL,
  unit_cost NUMERIC(18,4) NOT NULL,
  source TEXT NOT NULL,
  ref_type TEXT,
  ref_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_layers_fifo ON inventory_layers(product_id, warehouse_id, layer_date, id);

CREATE TABLE inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  movement_no TEXT NOT NULL,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN (
      'RECEIPT','ISSUE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','SCRAP',
      'RETURN_IN','RETURN_OUT','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_OUTPUT',
      'PICK','PUT_AWAY','DISPTACH','DELIVERY','CONSUMPTION')),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  from_warehouse_id BIGINT REFERENCES warehouses(id),
  from_bin_id BIGINT REFERENCES warehouse_bins(id),
  to_warehouse_id BIGINT REFERENCES warehouses(id),
  to_bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id BIGINT,
  reference_code TEXT,
  qr_id BIGINT,
  work_order_id BIGINT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','CANCELLED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id, created_at DESC);
CREATE INDEX idx_movements_ref ON inventory_movements(reference_type, reference_id);
CREATE INDEX idx_movements_wh ON inventory_movements(warehouse_id, created_at DESC);

CREATE TABLE inventory_reservations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  quantity NUMERIC(18,4) NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','CANCELLED','EXPIRED')),
  created_by BIGINT REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_ref ON inventory_reservations(reference_type, reference_id, status);

CREATE TABLE inventory_adjustments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  adjustment_no TEXT NOT NULL,
  adjustment_type TEXT NOT NULL DEFAULT 'CORRECTION'
    CHECK (adjustment_type IN ('STOCKTAKE','CYCLE_COUNT','DAMAGE','SCRAP','CORRECTION','QUARANTINE','RELEASE')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  reason TEXT NOT NULL,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  posted_by BIGINT,
  posted_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  UNIQUE (company_id, adjustment_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_adjustment_items (
  id BIGSERIAL PRIMARY KEY,
  adjustment_id BIGINT NOT NULL REFERENCES inventory_adjustments(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  counted_qty NUMERIC(18,4),
  expected_qty NUMERIC(18,4),
  variance_qty NUMERIC(18,4) NOT NULL,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_transfers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  transfer_no TEXT NOT NULL,
  from_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','IN_TRANSIT','COMPLETED','CANCELLED')),
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  UNIQUE (company_id, transfer_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_transfer_items (
  id BIGSERIAL PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  quantity NUMERIC(18,4) NOT NULL,
  from_bin_id BIGINT REFERENCES warehouse_bins(id),
  to_bin_id BIGINT REFERENCES warehouse_bins(id),
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Inventory engine: posts a movement and maintains balances,
-- batches, FIFO layers and weighted-average cost atomically.
-- ============================================================
CREATE OR REPLACE FUNCTION post_inventory_move(
  p_company bigint, p_tenant bigint, p_branch bigint,
  p_movement_type text, p_product bigint, p_batch bigint,
  p_warehouse bigint, p_bin bigint,
  p_from_warehouse bigint, p_from_bin bigint,
  p_to_warehouse bigint, p_to_bin bigint,
  p_quantity numeric, p_unit_cost numeric,
  p_ref_type text, p_ref_id bigint, p_ref_code text,
  p_qr bigint, p_work_order bigint, p_user bigint, p_reason text,
  p_valuation_method text DEFAULT 'WEIGHTED_AVERAGE'
) RETURNS bigint AS $$
DECLARE
  v_movement_id bigint;
  v_total numeric := p_quantity * p_unit_cost;
  v_no text;
  v_sign numeric;
  v_avg numeric;
  v_remaining numeric;
  v_batch_qty numeric;
  v_warehouse bigint;
  v_bin bigint;
  v_layer RECORD;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive';
  END IF;

  v_no := next_doc_no(p_tenant, 'MV');

  INSERT INTO inventory_movements (
    company_id, tenant_id, branch_id, movement_no, movement_type,
    product_id, batch_id, warehouse_id, bin_id,
    from_warehouse_id, from_bin_id, to_warehouse_id, to_bin_id,
    quantity, unit_cost, total_cost, reference_type, reference_id, reference_code,
    qr_id, work_order_id, created_by, reason
  ) VALUES (
    p_company, p_tenant, p_branch, v_no, p_movement_type,
    p_product, p_batch, p_warehouse, p_bin,
    p_from_warehouse, p_from_bin, p_to_warehouse, p_to_bin,
    p_quantity, p_unit_cost, v_total, p_ref_type, p_ref_id, p_ref_code,
    p_qr, p_work_order, p_user, p_reason
  ) RETURNING id INTO v_movement_id;

  -- Direction: which warehouse loses stock
  IF p_movement_type IN ('RECEIPT','TRANSFER_IN','PRODUCTION_OUTPUT','RETURN_IN','PUT_AWAY','ADJUSTMENT') THEN
    v_sign := 1;
    v_warehouse := COALESCE(p_warehouse, p_to_warehouse);
    v_bin := COALESCE(p_bin, p_to_bin);
  ELSE
    v_sign := -1;
    v_warehouse := COALESCE(p_warehouse, p_from_warehouse);
    v_bin := COALESCE(p_bin, p_from_bin);
  END IF;

  IF v_warehouse IS NULL THEN
    RAISE EXCEPTION 'Warehouse is required for movement';
  END IF;

  -- Update batch quantity (receipts increase, issues decrease)
  IF p_batch IS NOT NULL THEN
    UPDATE product_batches SET quantity = quantity + (v_sign * p_quantity)
    WHERE id = p_batch AND quantity + (v_sign * p_quantity) >= 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient batch quantity';
    END IF;
  END IF;

  -- Weighted average cost
  IF p_valuation_method = 'WEIGHTED_AVERAGE' OR p_valuation_method IS NULL THEN
    IF v_sign > 0 THEN
      INSERT INTO inventory (company_id, tenant_id, product_id, batch_id, warehouse_id, bin_id, quantity, reserved_qty, avg_cost, valuation_method)
      VALUES (p_company, p_tenant, p_product, p_batch, v_warehouse, v_bin, p_quantity, 0, p_unit_cost, 'WEIGHTED_AVERAGE')
      ON CONFLICT (product_id, batch_id, warehouse_id, bin_id) DO UPDATE SET
        quantity = inventory.quantity + EXCLUDED.quantity,
        avg_cost = CASE
          WHEN inventory.quantity <= 0 THEN EXCLUDED.avg_cost
          ELSE (inventory.avg_cost * inventory.quantity + EXCLUDED.quantity * EXCLUDED.avg_cost)
               / (inventory.quantity + EXCLUDED.quantity)
        END,
        updated_at = now();
    ELSE
      UPDATE inventory SET quantity = quantity - p_quantity, updated_at = now()
      WHERE product_id = p_product AND batch_id IS NOT DISTINCT FROM p_batch
        AND warehouse_id = v_warehouse AND bin_id IS NOT DISTINCT FROM v_bin
        AND quantity - p_quantity >= 0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient inventory on hand';
      END IF;
    END IF;

  ELSIF p_valuation_method = 'FIFO' THEN
    -- Receipt: create FIFO layer
    IF v_sign > 0 THEN
      INSERT INTO inventory_layers (company_id, tenant_id, product_id, batch_id, warehouse_id, layer_date, in_qty, remaining_qty, unit_cost, source, ref_type, ref_id)
      VALUES (p_company, p_tenant, p_product, p_batch, v_warehouse, CURRENT_DATE, p_quantity, p_quantity, p_unit_cost, p_movement_type, p_ref_type, p_ref_id);

      INSERT INTO inventory (company_id, tenant_id, product_id, batch_id, warehouse_id, bin_id, quantity, reserved_qty, avg_cost, valuation_method)
      VALUES (p_company, p_tenant, p_product, p_batch, v_warehouse, v_bin, p_quantity, 0, p_unit_cost, 'FIFO')
      ON CONFLICT (product_id, batch_id, warehouse_id, bin_id) DO UPDATE SET
        quantity = inventory.quantity + EXCLUDED.quantity, updated_at = now();
    ELSE
      -- Issue: consume oldest layers first
      v_remaining := p_quantity;
      FOR v_layer IN
        SELECT id, remaining_qty, unit_cost FROM inventory_layers
        WHERE product_id = p_product AND warehouse_id = v_warehouse
          AND (batch_id IS NOT DISTINCT FROM p_batch) AND remaining_qty > 0
        ORDER BY layer_date, id
      LOOP
        IF v_remaining <= 0 THEN EXIT; END IF;
        IF v_layer.remaining_qty >= v_remaining THEN
          UPDATE inventory_layers SET remaining_qty = remaining_qty - v_remaining WHERE id = v_layer.id;
          v_remaining := 0;
        ELSE
          UPDATE inventory_layers SET remaining_qty = 0 WHERE id = v_layer.id;
          v_remaining := v_remaining - v_layer.remaining_qty;
        END IF;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Insufficient FIFO stock on hand';
      END IF;
      UPDATE inventory SET quantity = quantity - p_quantity, updated_at = now()
      WHERE product_id = p_product AND batch_id IS NOT DISTINCT FROM p_batch
        AND warehouse_id = v_warehouse AND bin_id IS NOT DISTINCT FROM v_bin
        AND quantity - p_quantity >= 0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient inventory on hand';
      END IF;
    END IF;
  END IF;

  -- Two-leg transfer
  IF p_movement_type = 'TRANSFER_OUT' THEN
    PERFORM post_inventory_move(
      p_company, p_tenant, p_branch, 'TRANSFER_IN', p_product, p_batch,
      NULL, NULL, NULL, NULL, p_to_warehouse, p_to_bin,
      p_quantity, p_unit_cost, p_ref_type, p_ref_id, p_ref_code,
      p_qr, p_work_order, p_user, p_reason, p_valuation_method);
  END IF;

  RETURN v_movement_id;
END;
$$ LANGUAGE plpgsql;

-- Reserve / release helpers
CREATE OR REPLACE FUNCTION reserve_stock(
  p_company bigint, p_tenant bigint, p_product bigint, p_batch bigint,
  p_warehouse bigint, p_qty numeric, p_ref_type text, p_ref_id bigint,
  p_user bigint
) RETURNS bigint AS $$
DECLARE v_reservation bigint;
BEGIN
  PERFORM 1 FROM inventory
  WHERE product_id = p_product AND batch_id IS NOT DISTINCT FROM p_batch
    AND warehouse_id = p_warehouse
    AND quantity - reserved_qty >= p_qty
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient available stock to reserve';
  END IF;
  UPDATE inventory SET reserved_qty = reserved_qty + p_qty
  WHERE product_id = p_product AND batch_id IS NOT DISTINCT FROM p_batch
    AND warehouse_id = p_warehouse;
  INSERT INTO inventory_reservations (company_id, tenant_id, product_id, batch_id, warehouse_id, quantity, reference_type, reference_id, created_by)
  VALUES (p_company, p_tenant, p_product, p_batch, p_warehouse, p_qty, p_ref_type, p_ref_id, p_user)
  RETURNING id INTO v_reservation;
  RETURN v_reservation;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_reservation(p_reservation bigint) RETURNS void AS $$
BEGIN
  UPDATE inventory i SET reserved_qty = reserved_qty - r.quantity
  FROM inventory_reservations r
  WHERE r.id = p_reservation AND r.status = 'ACTIVE'
    AND i.product_id = r.product_id AND i.batch_id IS NOT DISTINCT FROM r.batch_id
    AND i.warehouse_id = r.warehouse_id;
  UPDATE inventory_reservations SET status = 'RELEASED' WHERE id = p_reservation AND status = 'ACTIVE';
END;
$$ LANGUAGE plpgsql;

-- RLS
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inventory USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_layers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_movements USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_reservations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_adjustments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_adjustment_items USING (adjustment_id IN (SELECT id FROM inventory_adjustments));
CREATE POLICY tenant_isolation ON inventory_transfers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_transfer_items USING (transfer_id IN (SELECT id FROM inventory_transfers));
