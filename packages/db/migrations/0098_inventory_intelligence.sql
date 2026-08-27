-- ============================================================
-- 0098 Inventory Intelligence, WMS, Traceability & Control
-- ============================================================
-- Mission-critical inventory layer: Item Master 2.0, inventory
-- states, immutable ledger, handling units, WMS workflows,
-- cycle counting, quality holds, recalls, costing, forecasting,
-- traceability events, alerts, risk and audit.

-- ---------- Item Master 2.0 ----------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS gtin TEXT,
  ADD COLUMN IF NOT EXISTS internal_code TEXT,
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS product_family TEXT,
  ADD COLUMN IF NOT EXISTS variant_name TEXT,
  ADD COLUMN IF NOT EXISTS country_of_origin TEXT,
  ADD COLUMN IF NOT EXISTS preferred_supplier_id BIGINT REFERENCES suppliers(id),
  ADD COLUMN IF NOT EXISTS moq NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS eoq NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS max_stock NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS abc_class TEXT CHECK (abc_class IN ('A','B','C')),
  ADD COLUMN IF NOT EXISTS xyz_class TEXT CHECK (xyz_class IN ('X','Y','Z')),
  ADD COLUMN IF NOT EXISTS batch_controlled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lot_controlled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS serial_controlled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_controlled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inspection_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS storage_requirements TEXT,
  ADD COLUMN IF NOT EXISTS hazard_class TEXT,
  ADD COLUMN IF NOT EXISTS cycle_count_frequency_days INTEGER,
  ADD COLUMN IF NOT EXISTS is_rfid_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin);
CREATE INDEX IF NOT EXISTS idx_products_family ON products(company_id, product_family);
CREATE INDEX IF NOT EXISTS idx_products_abc_xyz ON products(abc_class, xyz_class);
CREATE INDEX IF NOT EXISTS idx_products_internal_code ON products(internal_code);

-- ---------- Dynamic attribute framework ----------
CREATE TABLE item_attribute_definitions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  data_type TEXT NOT NULL DEFAULT 'TEXT'
    CHECK (data_type IN ('TEXT','NUMBER','BOOLEAN','DATE','SELECT','JSON')),
  applies_to TEXT NOT NULL DEFAULT 'ITEM'
    CHECK (applies_to IN ('ITEM','BATCH','LOCATION','HANDLING_UNIT')),
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_required BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item_attribute_values (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  definition_id BIGINT NOT NULL REFERENCES item_attribute_definitions(id),
  product_id BIGINT REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  location_id BIGINT REFERENCES warehouse_bins(id),
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attr_item ON item_attribute_values(definition_id, product_id)
  WHERE batch_id IS NULL AND location_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attr_batch ON item_attribute_values(definition_id, product_id, batch_id)
  WHERE batch_id IS NOT NULL AND location_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attr_location ON item_attribute_values(definition_id, location_id)
  WHERE product_id IS NULL AND batch_id IS NULL AND location_id IS NOT NULL;

-- ---------- Multi-unit conversions ----------
CREATE TABLE uom_conversions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT REFERENCES products(id),
  from_unit_id BIGINT NOT NULL REFERENCES units(id),
  to_unit_id BIGINT NOT NULL REFERENCES units(id),
  factor NUMERIC(24,8) NOT NULL CHECK (factor > 0),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uom_conv_product ON uom_conversions(product_id, from_unit_id, to_unit_id);

-- ---------- Warehouse intelligence columns ----------
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS capacity_qty NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS capacity_uom_id BIGINT REFERENCES units(id),
  ADD COLUMN IF NOT EXISTS temperature_controlled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_rfid_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE warehouse_zones
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'STORAGE'
    CHECK (type IN ('STORAGE','PICKING','STAGING','QUARANTINE','RETURNS','DAMAGED',
                    'RECEIVING','EXPEDITE','BULK','COLD')),
  ADD COLUMN IF NOT EXISTS temp_min_c NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS temp_max_c NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS hazard_class TEXT,
  ADD COLUMN IF NOT EXISTS capacity_qty NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE warehouse_racks
  ADD COLUMN IF NOT EXISTS aisle_code TEXT,
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE warehouse_shelves
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE warehouse_bins
  ADD COLUMN IF NOT EXISTS capacity_qty NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS picking_priority INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_counted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temperature_alert BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_bins_pick ON warehouse_bins(warehouse_id, picking_priority, is_blocked);

-- ---------- Inventory states ----------
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS quality_hold_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allocated_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS committed_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_transit_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_production_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarantine_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expired_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scrapped_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ;

-- ---------- Immutable inventory ledger ----------
CREATE TABLE inventory_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  serial_id BIGINT REFERENCES serial_numbers(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  from_warehouse_id BIGINT REFERENCES warehouses(id),
  from_bin_id BIGINT REFERENCES warehouse_bins(id),
  to_warehouse_id BIGINT REFERENCES warehouses(id),
  to_bin_id BIGINT REFERENCES warehouse_bins(id),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'RECEIPT','ISSUE','TRANSFER','ADJUSTMENT','RESERVATION','RELEASE','ALLOCATION',
      'PRODUCTION_CONSUMPTION','PRODUCTION_OUTPUT','RETURN','SCRAP','DAMAGE',
      'QUALITY_HOLD','QUALITY_RELEASE','QUARANTINE','RECLASSIFICATION','STOCK_COUNT',
      'OPENING_BALANCE','EXPIRY','REVERSAL')),
  state TEXT NOT NULL DEFAULT 'ON_HAND'
    CHECK (state IN (
      'ON_HAND','AVAILABLE','RESERVED','ALLOCATED','COMMITTED','IN_TRANSIT','IN_PRODUCTION',
      'QUALITY_HOLD','QUARANTINE','DAMAGED','REJECTED','BLOCKED','EXPIRED','RETURNED','SCRAPPED')),
  quantity_delta NUMERIC(18,4) NOT NULL,
  before_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  after_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  uom TEXT,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  reference_type TEXT,
  reference_id BIGINT,
  reference_code TEXT,
  reason_code TEXT,
  note TEXT,
  source_type TEXT,
  source_id BIGINT,
  created_by BIGINT REFERENCES users(id),
  device TEXT,
  approval_user_id BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON inventory_ledger(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_batch ON inventory_ledger(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON inventory_ledger(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_wh ON inventory_ledger(warehouse_id, created_at DESC);

-- Ledger rows are historical facts: never update, never delete.
CREATE OR REPLACE FUNCTION inventory_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_ledger is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_no_update
BEFORE UPDATE ON inventory_ledger
FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();

CREATE TRIGGER trg_ledger_no_delete
BEFORE DELETE ON inventory_ledger
FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();

-- ---------- Inventory transactions (status lifecycle) ----------
CREATE TABLE inventory_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  transaction_no TEXT NOT NULL,
  transaction_type TEXT NOT NULL
    CHECK (transaction_type IN (
      'RECEIPT','ISSUE','TRANSFER','ADJUSTMENT','RESERVATION','RELEASE','ALLOCATION',
      'PRODUCTION_CONSUMPTION','PRODUCTION_OUTPUT','RETURN','SCRAP','DAMAGE',
      'QUALITY_HOLD','QUALITY_RELEASE','QUARANTINE','RECLASSIFICATION','STOCK_COUNT',
      'OPENING_BALANCE')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT','SUBMITTED','PENDING_APPROVAL','APPROVED','IN_PROGRESS','POSTED',
      'COMPLETED','REJECTED','CANCELLED','REVERSED')),
  reversal_of BIGINT REFERENCES inventory_transactions(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  reference_type TEXT,
  reference_id BIGINT,
  reference_code TEXT,
  reason TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  posted_by BIGINT REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, transaction_no)
);
CREATE INDEX IF NOT EXISTS idx_inv_tx_status ON inventory_transactions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_inv_tx_ref ON inventory_transactions(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_reversal ON inventory_transactions(reversal_of);

CREATE TABLE inventory_transaction_lines (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES inventory_transactions(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  serial_id BIGINT REFERENCES serial_numbers(id),
  from_warehouse_id BIGINT REFERENCES warehouses(id),
  from_bin_id BIGINT REFERENCES warehouse_bins(id),
  to_warehouse_id BIGINT REFERENCES warehouses(id),
  to_bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  uom TEXT,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  reason_code TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_tx_lines_tx ON inventory_transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_lines_product ON inventory_transaction_lines(product_id);

-- ---------- Handling units (pallet / carton / ream hierarchy) ----------
CREATE TABLE handling_units (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  hu_type TEXT NOT NULL DEFAULT 'UNIT'
    CHECK (hu_type IN ('PALLET','CARTON','BOX','REAM','UNIT','DRUM','BUNDLE','CASE')),
  hu_no TEXT NOT NULL,
  sscc TEXT,
  gtin TEXT,
  barcode TEXT,
  parent_id BIGINT REFERENCES handling_units(id),
  product_id BIGINT REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIAL','FULL','EMPTY','MIXED','QUARANTINE','DISPOSED','TRANSIT')),
  is_mixed BOOLEAN NOT NULL DEFAULT false,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  weight_kg NUMERIC(12,4),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, hu_no)
);
CREATE INDEX IF NOT EXISTS idx_hu_parent ON handling_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_hu_location ON handling_units(warehouse_id, bin_id);
CREATE INDEX IF NOT EXISTS idx_hu_barcode ON handling_units(barcode);
CREATE INDEX IF NOT EXISTS idx_hu_sscc ON handling_units(sscc);

CREATE TABLE handling_unit_items (
  id BIGSERIAL PRIMARY KEY,
  handling_unit_id BIGINT NOT NULL REFERENCES handling_units(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  serial_id BIGINT REFERENCES serial_numbers(id),
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hui_hu ON handling_unit_items(handling_unit_id);
CREATE INDEX IF NOT EXISTS idx_hui_product ON handling_unit_items(product_id, batch_id);

-- ---------- Allocations ----------
CREATE TABLE inventory_allocations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','CANCELLED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alloc_ref ON inventory_allocations(reference_type, reference_id, status);
CREATE INDEX IF NOT EXISTS idx_alloc_product ON inventory_allocations(product_id, status);

-- ---------- Quality holds / quarantine ----------
CREATE TABLE quality_holds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  hold_no TEXT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD'
    CHECK (status IN ('HELD','RELEASED','REJECTED','PARTIALLY_RELEASED')),
  disposition TEXT
    CHECK (disposition IN ('APPROVED','REJECTED','SCRAP','RETURN_TO_SUPPLIER')),
  reference_type TEXT,
  reference_id BIGINT,
  inspection_id BIGINT,
  released_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  held_by BIGINT NOT NULL REFERENCES users(id),
  released_by BIGINT REFERENCES users(id),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, hold_no)
);
CREATE INDEX IF NOT EXISTS idx_qh_product ON quality_holds(product_id, status);
CREATE INDEX IF NOT EXISTS idx_qh_batch ON quality_holds(batch_id);

CREATE TABLE quarantine_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUARANTINED'
    CHECK (status IN ('QUARANTINED','RELEASED','REJECTED','DESTROYED','RETURNED')),
  reference_type TEXT,
  reference_id BIGINT,
  released_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  quarantined_by BIGINT NOT NULL REFERENCES users(id),
  released_by BIGINT REFERENCES users(id),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quarantine_product ON quarantine_records(product_id, status);

-- ---------- Cycle counting ----------
CREATE TABLE stock_counts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  count_no TEXT NOT NULL,
  count_type TEXT NOT NULL DEFAULT 'CYCLE'
    CHECK (count_type IN ('CYCLE','PHYSICAL','AD_HOC')),
  warehouse_id BIGINT REFERENCES warehouses(id),
  zone_id BIGINT REFERENCES warehouse_zones(id),
  scheduled_date DATE,
  due_date DATE,
  is_blind BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT','IN_PROGRESS','FIRST_COUNT','SECOND_COUNT','PENDING_REVIEW',
      'APPROVED','POSTED','CANCELLED')),
  counted_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  posted_by BIGINT REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, count_no)
);
CREATE INDEX IF NOT EXISTS idx_stock_counts_status ON stock_counts(warehouse_id, status, due_date);

CREATE TABLE stock_count_lines (
  id BIGSERIAL PRIMARY KEY,
  count_id BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  system_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  counted_qty NUMERIC(18,4),
  second_count_qty NUMERIC(18,4),
  variance_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','MATCH','VARIANCE','SECOND_COUNT','REVIEWED','ADJUSTED')),
  note TEXT,
  counted_by BIGINT REFERENCES users(id),
  counted_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_count_lines_count ON stock_count_lines(count_id);
CREATE INDEX IF NOT EXISTS idx_count_lines_product ON stock_count_lines(product_id, bin_id);

-- ---------- Replenishment ----------
CREATE TABLE replenishment_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  rule_type TEXT NOT NULL DEFAULT 'MIN_MAX'
    CHECK (rule_type IN ('MIN_MAX','ROP','EOQ','FORECAST_DRIVEN')),
  min_qty NUMERIC(18,4),
  max_qty NUMERIC(18,4),
  reorder_point NUMERIC(18,4),
  eoq_qty NUMERIC(18,4),
  safety_stock NUMERIC(18,4),
  lead_time_days INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_id, warehouse_id, rule_type)
);

CREATE TABLE reorder_recommendations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  recommended_qty NUMERIC(18,4) NOT NULL,
  current_available NUMERIC(18,4) NOT NULL DEFAULT 0,
  demand_forecast NUMERIC(18,4) NOT NULL DEFAULT 0,
  safety_stock NUMERIC(18,4) NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  basis TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','APPROVED','CONVERTED','DISMISSED','EXPIRED')),
  suggested_order_type TEXT CHECK (suggested_order_type IN ('PURCHASE','PRODUCTION','TRANSFER')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reorder_status ON reorder_recommendations(product_id, status);

-- ---------- Landed cost ----------
CREATE TABLE landed_costs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  landed_cost_no TEXT NOT NULL,
  supplier_id BIGINT REFERENCES suppliers(id),
  purchase_order_id BIGINT,
  goods_receipt_id BIGINT,
  allocation_method TEXT NOT NULL DEFAULT 'QUANTITY'
    CHECK (allocation_method IN ('QUANTITY','WEIGHT','VALUE','VOLUME','MANUAL')),
  total_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','CANCELLED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  posted_by BIGINT REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, landed_cost_no)
);

CREATE TABLE landed_cost_lines (
  id BIGSERIAL PRIMARY KEY,
  landed_cost_id BIGINT NOT NULL REFERENCES landed_costs(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  cost_type TEXT NOT NULL
    CHECK (cost_type IN ('FREIGHT','INSURANCE','HANDLING','TAXES','CUSTOMS','OTHER')),
  amount NUMERIC(18,4) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Valuation ----------
CREATE TABLE inventory_valuations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  valuation_date DATE NOT NULL,
  valuation_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  total_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  total_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_valuations_date ON inventory_valuations(company_id, valuation_date DESC);

CREATE TABLE inventory_abc_xyz_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  snapshot_date DATE NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  abc_class TEXT CHECK (abc_class IN ('A','B','C')),
  xyz_class TEXT CHECK (xyz_class IN ('X','Y','Z')),
  annual_usage_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  demand_variability NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, snapshot_date, product_id)
);

-- ---------- Forecasting ----------
CREATE TABLE inventory_forecasts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  forecast_date DATE NOT NULL,
  horizon_days INTEGER NOT NULL DEFAULT 30,
  method TEXT NOT NULL DEFAULT 'MOVING_AVERAGE'
    CHECK (method IN ('MOVING_AVERAGE','EXPONENTIAL_SMOOTHING','SEASONAL','LINEAR_TREND','AI')),
  forecast_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  confidence NUMERIC(6,4) NOT NULL DEFAULT 0,
  stockout_in_days INTEGER,
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','OVERRIDDEN','SUPERSEDED')),
  overridden_by BIGINT REFERENCES users(id),
  overridden_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forecasts_product ON inventory_forecasts(product_id, forecast_date DESC);

-- ---------- Alerts ----------
CREATE TABLE inventory_alerts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  alert_type TEXT NOT NULL
    CHECK (alert_type IN (
      'STOCKOUT','LOW_STOCK','OVERSTOCK','EXPIRY','QUALITY_HOLD','VARIANCE','SYNC_FAILED',
      'PENDING_APPROVAL','DELAYED_RECEIVING','DELAYED_PUTAWAY','DELAYED_PICKING',
      'CAPACITY','SUSPICIOUS_ADJUSTMENT','DATA_QUALITY')),
  severity TEXT NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  product_id BIGINT REFERENCES products(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  batch_id BIGINT REFERENCES product_batches(id),
  title TEXT NOT NULL,
  message TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
  acknowledged_by BIGINT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON inventory_alerts(status, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_product ON inventory_alerts(product_id);

-- ---------- Audit trail ----------
CREATE TABLE inventory_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  action TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  variance NUMERIC(18,4),
  reason TEXT,
  reference_type TEXT,
  reference_id BIGINT,
  reference_code TEXT,
  approval_user_id BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  device TEXT,
  ip_address TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON inventory_audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON inventory_audit_logs(created_by, created_at DESC);

-- Auto-log ledger writes so the audit trail can never be bypassed.
CREATE OR REPLACE FUNCTION inventory_ledger_audit() RETURNS trigger AS $$
BEGIN
  INSERT INTO inventory_audit_logs (
    company_id, tenant_id, entity_type, entity_id, action, before_value, after_value,
    variance, reason, reference_type, reference_id, reference_code,
    approval_user_id, approved_at, device, created_by
  ) VALUES (
    NEW.company_id, NEW.tenant_id, 'inventory_ledger', NEW.id, NEW.event_type,
    jsonb_build_object('before_qty', NEW.before_qty),
    jsonb_build_object('after_qty', NEW.after_qty, 'delta', NEW.quantity_delta),
    NEW.after_qty - NEW.before_qty,
    COALESCE(NEW.reason_code, NEW.note),
    NEW.reference_type, NEW.reference_id, NEW.reference_code,
    NEW.approval_user_id, NEW.approved_at, NEW.device, NEW.created_by
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_audit
AFTER INSERT ON inventory_ledger
FOR EACH ROW EXECUTE FUNCTION inventory_ledger_audit();

-- ---------- Traceability events (EPCIS-aligned) ----------
CREATE TABLE traceability_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  event_type TEXT NOT NULL DEFAULT 'OBJECT_EVENT'
    CHECK (event_type IN ('OBJECT_EVENT','AGGREGATION_EVENT','TRANSFORMATION_EVENT','TRANSACTION_EVENT')),
  action TEXT NOT NULL DEFAULT 'OBSERVE'
    CHECK (action IN ('OBSERVE','ADD','DELETE')),
  biz_step TEXT NOT NULL
    CHECK (biz_step IN (
      'RECEIVING','INSPECTION','PUTAWAY','STORING','PICKING','PACKING','STAGING',
      'SHIPPING','DELIVERY','PRODUCTION','CONSUMPTION','RETURN','RECALL',
      'QUALITY_HOLD','QUALITY_RELEASE','COUNTING','ADJUSTMENT','MINTING')),
  disposition TEXT,
  product_id BIGINT REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  serial_id BIGINT REFERENCES serial_numbers(id),
  handling_unit_id BIGINT REFERENCES handling_units(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  read_point TEXT,
  biz_location TEXT,
  epc_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  kdes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type TEXT,
  source_id BIGINT,
  source_code TEXT,
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by BIGINT REFERENCES users(id),
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trace_batch ON traceability_events(batch_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_trace_product ON traceability_events(product_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_trace_hu ON traceability_events(handling_unit_id);
CREATE INDEX IF NOT EXISTS idx_trace_source ON traceability_events(source_type, source_id);

-- Extend the recalls table created in 0008_qr_system.sql (additive only).
ALTER TABLE recalls
  ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id),
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS quarantine_all BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id);

ALTER TABLE recalls
  DROP CONSTRAINT IF EXISTS recalls_severity_check,
  ADD CONSTRAINT recalls_severity_check
    CHECK (severity IN ('STANDARD','MAJOR','CRITICAL','LOW','MEDIUM','HIGH'));

ALTER TABLE recalls
  DROP CONSTRAINT IF EXISTS recalls_status_check,
  ADD CONSTRAINT recalls_status_check
    CHECK (status IN ('ACTIVE','CLOSED','OPEN','QUARANTINED','IN_PROGRESS','COMPLETED'));

CREATE TABLE recall_batches (
  id BIGSERIAL PRIMARY KEY,
  recall_id BIGINT NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  batch_id BIGINT NOT NULL REFERENCES product_batches(id),
  quantity_affected NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_on_hand NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_in_transit NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_with_customers NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'IDENTIFIED'
    CHECK (status IN ('IDENTIFIED','QUARANTINED','RECALLED','DESTROYED','RETURNED','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recall_batches ON recall_batches(batch_id, status);

-- ---------- Risk scoring ----------
CREATE TABLE inventory_risk_scores (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT REFERENCES products(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  risk_level TEXT NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  score NUMERIC(8,4) NOT NULL DEFAULT 0,
  factors JSONB NOT NULL DEFAULT '{}'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_product ON inventory_risk_scores(product_id, scored_at DESC);

-- ---------- Helpers ----------
CREATE OR REPLACE FUNCTION record_inventory_event(
  p_company bigint, p_tenant bigint, p_event_type text, p_product bigint,
  p_qty numeric, p_batch bigint DEFAULT NULL, p_warehouse bigint DEFAULT NULL,
  p_bin bigint DEFAULT NULL, p_from_warehouse bigint DEFAULT NULL,
  p_from_bin bigint DEFAULT NULL, p_to_warehouse bigint DEFAULT NULL,
  p_to_bin bigint DEFAULT NULL, p_state text DEFAULT 'ON_HAND',
  p_unit_cost numeric DEFAULT 0, p_currency text DEFAULT 'UGX',
  p_reference_type text DEFAULT NULL, p_reference_id bigint DEFAULT NULL,
  p_reference_code text DEFAULT NULL, p_reason_code text DEFAULT NULL,
  p_note text DEFAULT NULL, p_user bigint DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS bigint AS $$
DECLARE v_ledger bigint;
  v_balance numeric;
BEGIN
  SELECT COALESCE(SUM(quantity), 0) INTO v_balance
  FROM inventory
  WHERE product_id = p_product
    AND batch_id IS NOT DISTINCT FROM p_batch
    AND warehouse_id IS NOT DISTINCT FROM p_warehouse
    AND bin_id IS NOT DISTINCT FROM p_bin;

  INSERT INTO inventory_ledger (
    company_id, tenant_id, product_id, batch_id, warehouse_id, bin_id,
    from_warehouse_id, from_bin_id, to_warehouse_id, to_bin_id,
    event_type, state, quantity_delta, before_qty, after_qty,
    unit_cost, total_cost, currency, reference_type, reference_id,
    reference_code, reason_code, note, created_by, device
  ) VALUES (
    p_company, p_tenant, p_product, p_batch, p_warehouse, p_bin,
    p_from_warehouse, p_from_bin, p_to_warehouse, p_to_bin,
    p_event_type, p_state, p_qty, v_balance, v_balance + p_qty,
    p_unit_cost, p_unit_cost * p_qty, p_currency, p_reference_type,
    p_reference_id, p_reference_code, p_reason_code, p_note, p_user, p_device
  ) RETURNING id INTO v_ledger;
  RETURN v_ledger;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_traceability_event(
  p_company bigint, p_tenant bigint, p_biz_step text, p_action text,
  p_product bigint DEFAULT NULL, p_batch bigint DEFAULT NULL,
  p_warehouse bigint DEFAULT NULL, p_bin bigint DEFAULT NULL,
  p_handling_unit bigint DEFAULT NULL, p_epc_list jsonb DEFAULT '[]'::jsonb,
  p_kdes jsonb DEFAULT '{}'::jsonb, p_source_type text DEFAULT NULL,
  p_source_id bigint DEFAULT NULL, p_source_code text DEFAULT NULL,
  p_user bigint DEFAULT NULL, p_device text DEFAULT NULL,
  p_event_type text DEFAULT 'OBJECT_EVENT', p_disposition text DEFAULT NULL,
  p_branch bigint DEFAULT NULL
) RETURNS bigint AS $$
DECLARE v_event bigint;
BEGIN
  INSERT INTO traceability_events (
    company_id, tenant_id, branch_id, event_type, action, biz_step, disposition,
    product_id, batch_id, handling_unit_id, warehouse_id, bin_id,
    epc_list, kdes, source_type, source_id, source_code, recorded_by, device
  ) VALUES (
    p_company, p_tenant, p_branch, p_event_type, p_action, p_biz_step, p_disposition,
    p_product, p_batch, p_handling_unit, p_warehouse, p_bin,
    p_epc_list, p_kdes, p_source_type, p_source_id, p_source_code, p_user, p_device
  ) RETURNING id INTO v_event;
  RETURN v_event;
END;
$$ LANGUAGE plpgsql;

-- ---------- Row-level security ----------
ALTER TABLE item_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE handling_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE handling_unit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE reorder_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE landed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE landed_cost_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_abc_xyz_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recall_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_risk_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON item_attribute_definitions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON item_attribute_values USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON uom_conversions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_ledger USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_transactions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_transaction_lines USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON handling_units USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON handling_unit_items USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_allocations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON quality_holds USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON quarantine_records USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON stock_counts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON stock_count_lines USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON replenishment_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON reorder_recommendations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON landed_costs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON landed_cost_lines USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_valuations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_abc_xyz_snapshots USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_forecasts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_alerts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_audit_logs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON traceability_events USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON recall_batches USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inventory_risk_scores USING (tenant_id = app_tenant_id());
