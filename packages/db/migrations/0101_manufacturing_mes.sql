-- ============================================================
-- 0101 Manufacturing MES (Execution, Quality, Scheduling, Costing)
-- ============================================================
-- Extends 0002 (master) / 0006 (production + quality) / 0083 (costing)
-- with the full MES execution layer.

-- ---------- Work order lifecycle extension ----------
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS bom_version_id BIGINT,
  ADD COLUMN IF NOT EXISTS released_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS materials_reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS materials_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (source_type IN ('MANUAL','SALES_ORDER','FORECAST','PLAN','MTO','MTS','REWORK','SUBCONTRACT')),
  ADD COLUMN IF NOT EXISTS product_family_id BIGINT,
  ADD COLUMN IF NOT EXISTS production_batch_id BIGINT;

ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','RELEASED','MATERIALS_RESERVED',
                    'MATERIALS_ISSUED','IN_PROGRESS','QUALITY_INSPECTION','ON_HOLD',
                    'COMPLETED','CLOSED','REJECTED','CANCELLED'));

-- Machine state (richer than legacy status; status kept for compatibility)
ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS asset_id BIGINT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS machine_state TEXT NOT NULL DEFAULT 'IDLE'
    CHECK (machine_state IN ('RUNNING','IDLE','SETUP','CHANGEOVER','MAINTENANCE',
                             'BREAKDOWN','QUALITY_HOLD','OFFLINE')),
  ADD COLUMN IF NOT EXISTS production_hours NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downtime_hours NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maintenance_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (maintenance_status IN ('NONE','DUE','IN_PROGRESS','OVERDUE'));

-- ---------- 1. Product master (families + variants) ----------
CREATE TABLE product_families (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  family_id BIGINT REFERENCES product_families(id),
  variant_code TEXT NOT NULL,
  grade TEXT,
  gsm NUMERIC(10,2),
  dimensions TEXT,
  pack_size INTEGER,
  carton_config TEXT,
  pallet_config TEXT,
  specification TEXT,
  packaging_format TEXT,
  standard_cost NUMERIC(18,4),
  target_yield NUMERIC(8,4),
  standard_waste_pct NUMERIC(8,4),
  quality_spec TEXT,
  shelf_life_days INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, variant_code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pv_product ON product_variants(product_id);

-- ---------- 2. Versioned BOM engine ----------
CREATE TABLE bom_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  bom_id BIGINT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  code TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','OBSOLETE','ARCHIVED')),
  is_current BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE,
  effective_to DATE,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, bom_id, version_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bom_versions_bom ON bom_versions(bom_id);

CREATE TABLE bom_version_lines (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  bom_version_id BIGINT NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  component_code TEXT,
  component_name TEXT,
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  scrap_factor NUMERIC(8,4) NOT NULL DEFAULT 0,
  yield_factor NUMERIC(8,4) NOT NULL DEFAULT 1,
  is_phantom BOOLEAN NOT NULL DEFAULT false,
  is_consumable BOOLEAN NOT NULL DEFAULT false,
  substitute_group TEXT,
  UNIQUE (bom_version_id, seq),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bvl_version ON bom_version_lines(bom_version_id);

CREATE TABLE bom_substitutes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  bom_line_id BIGINT NOT NULL REFERENCES bom_version_lines(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  priority INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bom_co_products (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  bom_version_id BIGINT NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  co_type TEXT NOT NULL CHECK (co_type IN ('MAIN','BY_PRODUCT','CO_PRODUCT','SCRAP')),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  valuation_rule TEXT NOT NULL DEFAULT 'NONE'
    CHECK (valuation_rule IN ('NONE','STANDARD_COST','PERCENTAGE','FIXED')),
  valuation_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 3. Routing extensions ----------
CREATE TABLE routing_operation_materials (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  routing_operation_id BIGINT NOT NULL REFERENCES routing_operations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  is_consumable BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routing_operation_quality_checks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  routing_operation_id BIGINT NOT NULL REFERENCES routing_operations(id) ON DELETE CASCADE,
  check_code TEXT,
  check_name TEXT,
  standard_value TEXT,
  standard_min NUMERIC(18,4),
  standard_max NUMERIC(18,4),
  unit TEXT,
  is_required BOOLEAN NOT NULL DEFAULT true,
  seq INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_instructions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  routing_operation_id BIGINT REFERENCES routing_operations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','OBSOLETE')),
  content TEXT,
  safety_instructions TEXT,
  machine_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_current BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (company_id, code, version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. Machine capacity ----------
CREATE TABLE machine_capacity (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  work_centre_id BIGINT REFERENCES work_centres(id),
  capacity_date DATE NOT NULL,
  shift_code TEXT,
  available_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  scheduled_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  downtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  maintenance_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  changeover_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  break_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  remaining_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  utilization_pct NUMERIC(8,4),
  efficiency_pct NUMERIC(8,4),
  oee_pct NUMERIC(8,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_machine_capacity
  ON machine_capacity (company_id, machine_id, capacity_date, COALESCE(shift_code,''));
-- ---------- 5. Production batches (MES batch record) ----------
CREATE TABLE production_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  batch_no TEXT NOT NULL,
  work_order_id BIGINT REFERENCES work_orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  bom_version_id BIGINT REFERENCES bom_versions(id),
  routing_id BIGINT REFERENCES routings(id),
  machine_id BIGINT REFERENCES machines(id),
  work_centre_id BIGINT REFERENCES work_centres(id),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  good_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  rejected_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  scrap_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  rework_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PRODUCTION','QUALITY_HOLD','QUARANTINE','COMPLETED',
                      'CLOSED','REJECTED','REWORK')),
  batch_date DATE NOT NULL DEFAULT CURRENT_DATE,
  shift_code TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  operators JSONB NOT NULL DEFAULT '[]'::jsonb,
  material_batches JSONB NOT NULL DEFAULT '[]'::jsonb,
  packaging JSONB NOT NULL DEFAULT '{}'::jsonb,
  pallet JSONB NOT NULL DEFAULT '{}'::jsonb,
  finished_goods_location JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_result TEXT,
  ebr_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, batch_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pb_wo ON production_batches(work_order_id);
CREATE INDEX idx_pb_product ON production_batches(product_id);
CREATE INDEX idx_pb_status ON production_batches(status);

-- ---------- 6. WIP balances ----------
CREATE TABLE wip_balances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  routing_operation_id BIGINT REFERENCES routing_operations(id),
  work_centre_id BIGINT REFERENCES work_centres(id),
  machine_id BIGINT REFERENCES machines(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  last_posting_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_wip_balance
  ON wip_balances (company_id, work_order_id, COALESCE(routing_operation_id,0), product_id);

-- ---------- 7. Material reservations (MES) ----------
CREATE TABLE production_material_reservations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  reservation_no TEXT NOT NULL,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  required_qty NUMERIC(18,4) NOT NULL,
  reserved_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  issued_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  consumed_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','RESERVED','PICKED','ISSUED','CONSUMED','PARTIAL','RELEASED','CANCELLED')),
  reserved_at TIMESTAMPTZ,
  picked_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  inventory_reservation_id BIGINT,
  created_by BIGINT,
  UNIQUE (company_id, reservation_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pmr_wo ON production_material_reservations(work_order_id);

CREATE TABLE production_material_issues (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  issue_no TEXT NOT NULL,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  reservation_id BIGINT REFERENCES production_material_reservations(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  issue_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (issue_type IN ('NORMAL','SUBCONTRACT','RETURN','REWORK')),
  scanned_at TIMESTAMPTZ,
  scanned_by BIGINT,
  fifo_confirmed BOOLEAN NOT NULL DEFAULT true,
  quality_status TEXT,
  override_reason TEXT,
  override_by BIGINT,
  override_at TIMESTAMPTZ,
  movement_id BIGINT,
  UNIQUE (company_id, issue_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pmi_wo ON production_material_issues(work_order_id);

-- ---------- 8. Scrap and waste ----------
CREATE TABLE scrap_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  production_batch_id BIGINT REFERENCES production_batches(id),
  machine_id BIGINT REFERENCES machines(id),
  operator_id BIGINT,
  shift_code TEXT,
  product_id BIGINT NOT NULL REFERENCES products(id),
  scrap_type TEXT NOT NULL DEFAULT 'PRODUCTION'
    CHECK (scrap_type IN ('PRODUCTION','MATERIAL','REWORK','FINAL')),
  quantity NUMERIC(18,4) NOT NULL,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  reason TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by BIGINT,
  movement_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_scrap_wo ON scrap_records(work_order_id);
CREATE INDEX idx_scrap_batch ON scrap_records(production_batch_id);

CREATE TABLE waste_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  production_batch_id BIGINT REFERENCES production_batches(id),
  machine_id BIGINT REFERENCES machines(id),
  operator_id BIGINT,
  shift_code TEXT,
  waste_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (waste_type IN ('NORMAL','ABNORMAL')),
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('SETUP','CUTTING','TRIM','STARTUP','CHANGEOVER','OPERATOR','MACHINE','MATERIAL','OTHER')),
  input_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  waste_qty NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  reason TEXT,
  is_abnormal BOOLEAN NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_waste_wo ON waste_records(work_order_id);

-- ---------- 9. Downtime events (MES) ----------
CREATE TABLE downtime_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  production_batch_id BIGINT REFERENCES production_batches(id),
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  work_centre_id BIGINT REFERENCES work_centres(id),
  operator_id BIGINT,
  shift_code TEXT,
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('MECHANICAL','ELECTRICAL','MATERIAL_SHORTAGE','QUALITY_ISSUE',
                        'SETUP','CHANGEOVER','CLEANING','OPERATOR','UTILITY_FAILURE',
                        'MAINTENANCE','OTHER')),
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  maintenance_work_order_id BIGINT,
  recorded_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dte_machine ON downtime_events(machine_id, started_at);
CREATE INDEX idx_dte_wo ON downtime_events(work_order_id);
-- ---------- 10. Quality holds and dispositions ----------
CREATE TABLE production_quality_holds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  hold_no TEXT NOT NULL,
  production_batch_id BIGINT NOT NULL REFERENCES production_batches(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  reason TEXT NOT NULL,
  held_qty NUMERIC(18,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD'
    CHECK (status IN ('HELD','INVESTIGATING','QUARANTINE','DISPOSED','RELEASED')),
  held_by BIGINT,
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by BIGINT,
  released_at TIMESTAMPTZ,
  UNIQUE (company_id, hold_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quality_dispositions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  hold_id BIGINT NOT NULL REFERENCES production_quality_holds(id) ON DELETE CASCADE,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('RELEASE','REWORK','DOWNGRADE','RETURN_TO_PRODUCTION','SCRAP','REJECT')),
  quantity NUMERIC(18,4) NOT NULL,
  reason TEXT,
  decided_by BIGINT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rework_order_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 11. Rework orders ----------
CREATE TABLE rework_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  rework_no TEXT NOT NULL,
  source_work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  production_batch_id BIGINT REFERENCES production_batches(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','RELEASED','IN_PROGRESS','QUALITY_INSPECTION',
                      'COMPLETED','REJECTED','CANCELLED')),
  material_required JSONB NOT NULL DEFAULT '{}'::jsonb,
  rework_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (company_id, rework_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 12. Subcontracting ----------
CREATE TABLE subcontract_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  subcon_no TEXT NOT NULL,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  operation_id BIGINT REFERENCES routing_operations(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','MATERIALS_ISSUED','IN_TRANSIT','AT_VENDOR',
                      'RECEIVED','QUALITY_INSPECTION','COMPLETED','CANCELLED')),
  material_issued_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  vendor_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  issued_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (company_id, subcon_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 13. Changeover logs ----------
CREATE TABLE changeover_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  from_product_id BIGINT REFERENCES products(id),
  to_product_id BIGINT REFERENCES products(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  planned_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS','COMPLETED','DELAYED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 14. Machine logs ----------
CREATE TABLE machine_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('STARTED','STOPPED','BREAKDOWN','SETUP','CHANGEOVER',
                          'MAINTENANCE_STARTED','MAINTENANCE_COMPLETED',
                          'QUALITY_HOLD','RELEASED','OFFLINE')),
  status_from TEXT,
  status_to TEXT,
  reason TEXT,
  operator_id BIGINT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ml_machine ON machine_logs(machine_id, occurred_at);

-- ---------- 15. Production schedules (visual + finite capacity) ----------
CREATE TABLE production_schedules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  schedule_no TEXT NOT NULL,
  schedule_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','EXECUTING','COMPLETED','CANCELLED')),
  created_by BIGINT,
  UNIQUE (company_id, schedule_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_schedule_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  schedule_id BIGINT NOT NULL REFERENCES production_schedules(id) ON DELETE CASCADE,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  machine_id BIGINT REFERENCES machines(id),
  work_centre_id BIGINT REFERENCES work_centres(id),
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end TIMESTAMPTZ NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  sequence INTEGER NOT NULL DEFAULT 1,
  changeover_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','CONFIRMED','IN_PROGRESS','COMPLETED','DELAYED','CANCELLED')),
  UNIQUE (schedule_id, work_order_id, machine_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pse_machine ON production_schedule_entries(machine_id, planned_start);

-- ---------- 16. Shift handover ----------
CREATE TABLE production_shift_handovers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  handover_no TEXT NOT NULL,
  work_order_id BIGINT REFERENCES work_orders(id),
  machine_id BIGINT REFERENCES machines(id),
  from_shift_code TEXT NOT NULL,
  to_shift_code TEXT,
  shift_date DATE NOT NULL DEFAULT CURRENT_DATE,
  produced_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  outstanding_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  machine_status TEXT,
  issues TEXT,
  material_status TEXT,
  quality_status TEXT,
  handover_notes TEXT,
  from_operator_id BIGINT,
  to_operator_id BIGINT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACKNOWLEDGED','COMPLETED')),
  UNIQUE (company_id, handover_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 17. Material availability checks ----------
CREATE TABLE material_availability_checks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  check_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PASS' CHECK (status IN ('PASS','FAIL','PARTIAL')),
  result JSONB NOT NULL DEFAULT '[]'::jsonb,
  overridden BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,
  overridden_by BIGINT,
  overridden_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_by BIGINT,
  UNIQUE (company_id, check_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 18. Production alerts ----------
CREATE TABLE production_alerts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('MATERIAL_SHORTAGE','MACHINE_BREAKDOWN','PRODUCTION_DELAY',
                          'QUALITY_FAILURE','HIGH_WASTE','OEE_BELOW_TARGET',
                          'ORDER_DEADLINE','MAINTENANCE_DUE','MATERIAL_RUNNING_LOW',
                          'CAPACITY_OVERLOAD','APPROVAL_PENDING')),
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title TEXT NOT NULL,
  message TEXT,
  ref_type TEXT,
  ref_id BIGINT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  acknowledged_by BIGINT,
  acknowledged_at TIMESTAMPTZ,
  resolved_by BIGINT,
  resolved_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pa_status ON production_alerts(status, severity);

-- ---------- 19. Immutable manufacturing events ----------
CREATE TABLE manufacturing_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  entity_code TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT
);
CREATE INDEX idx_me_event ON manufacturing_events(event_type, occurred_at);
CREATE INDEX idx_me_entity ON manufacturing_events(entity_type, entity_id);

-- Immutable event ledger: no updates, no deletes.
CREATE OR REPLACE FUNCTION manufacturing_events_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manufacturing_events is an immutable ledger';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_manufacturing_events_no_update ON manufacturing_events;
CREATE TRIGGER trg_manufacturing_events_no_update
  BEFORE UPDATE OR DELETE ON manufacturing_events
  FOR EACH ROW EXECUTE FUNCTION manufacturing_events_no_mutation();

-- ---------- 20. Auto-generated manufacturing documents ----------
CREATE TABLE production_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  doc_type TEXT NOT NULL
    CHECK (doc_type IN ('PRODUCTION_ORDER','MATERIAL_REQUISITION','MATERIAL_ISSUE_NOTE',
                        'JOB_CARD','ROUTE_SHEET','WORK_ORDER','PRODUCTION_REPORT',
                        'SHIFT_REPORT','MACHINE_LOG','DOWNTIME_REPORT','WASTE_REPORT',
                        'SCRAP_REPORT','QUALITY_INSPECTION','REWORK_ORDER',
                        'PRODUCTION_COMPLETION_NOTE','FINISHED_GOODS_RECEIPT',
                        'SHIFT_HANDOVER','MAINTENANCE_REQUEST','BATCH_RECORD')),
  doc_no TEXT NOT NULL,
  work_order_id BIGINT REFERENCES work_orders(id),
  ref_type TEXT,
  ref_id BIGINT,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED','PRINTED','VOID')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by BIGINT,
  UNIQUE (company_id, doc_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 21. Production variances ----------
CREATE TABLE production_variances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  variance_type TEXT NOT NULL
    CHECK (variance_type IN ('MATERIAL','LABOUR','MACHINE','OVERHEAD','WASTE','YIELD','COST')),
  standard_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  variance NUMERIC(18,4) NOT NULL DEFAULT 0,
  variance_pct NUMERIC(8,4),
  reason TEXT,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pv_wo ON production_variances(work_order_id);
-- ---------- 22. MES views ----------
CREATE OR REPLACE VIEW v_production_progress AS
SELECT wo.id AS work_order_id, wo.wo_no, wo.status, wo.priority, wo.source_type,
       wo.quantity, wo.released_qty, wo.produced_qty, wo.scrapped_qty, wo.rework_qty,
       wo.waste_qty, wo.due_date, wo.started_at, wo.completed_at, wo.machine_id,
       p.id AS product_id, p.code AS product_code, p.name AS product_name, p.type,
       m.code AS machine_code, m.machine_state,
       CASE WHEN wo.quantity > 0 THEN round((wo.produced_qty / wo.quantity) * 100, 2)
            ELSE 0 END AS completion_pct,
       GREATEST(0, wo.quantity - wo.produced_qty - wo.scrapped_qty - wo.rework_qty) AS remaining_qty
FROM work_orders wo
JOIN products p ON p.id = wo.product_id
LEFT JOIN machines m ON m.id = wo.machine_id;

CREATE OR REPLACE VIEW v_machine_oee AS
SELECT m.id AS machine_id, m.code AS machine_code, m.name AS machine_name,
       m.machine_state, m.status AS legacy_status, m.capacity,
       COALESCE(mc.available_hours, 0) AS available_hours,
       COALESCE(mc.scheduled_hours, 0) AS scheduled_hours,
       COALESCE(mc.actual_hours, 0) AS actual_hours,
       COALESCE(mc.downtime_hours, 0) AS downtime_hours,
       COALESCE(mc.remaining_hours, 0) AS remaining_hours,
       mc.capacity_date,
       round((CASE WHEN mc.available_hours > 0
             THEN (mc.available_hours - mc.downtime_hours) / mc.available_hours * 100
             ELSE 0 END)::numeric, 2) AS availability_pct,
       round((CASE WHEN (mc.available_hours - mc.downtime_hours) > 0
             THEN mc.actual_hours / (mc.available_hours - mc.downtime_hours) * 100
             ELSE 0 END)::numeric, 2) AS performance_pct,
       round((CASE WHEN mc.scheduled_hours > 0 AND mc.actual_hours > 0
             THEN (mc.actual_hours - mc.downtime_hours) / mc.scheduled_hours * 100
             ELSE 0 END)::numeric, 2) AS quality_pct,
       round((CASE WHEN mc.available_hours > 0 AND mc.actual_hours > 0
             THEN ((mc.available_hours - mc.downtime_hours) / mc.available_hours) *
                  (mc.actual_hours / GREATEST(1,(mc.available_hours - mc.downtime_hours))) *
                  ((mc.actual_hours - mc.downtime_hours) / GREATEST(1,mc.scheduled_hours)) * 100
             ELSE 0 END)::numeric, 2) AS oee_pct
FROM machines m
LEFT JOIN LATERAL (
  SELECT * FROM machine_capacity mc2
  WHERE mc2.machine_id = m.id AND mc2.capacity_date = CURRENT_DATE
  ORDER BY mc2.id DESC LIMIT 1
) mc ON true;

CREATE OR REPLACE VIEW v_wip_snapshot AS
SELECT wb.work_order_id, wo.wo_no, wb.routing_operation_id, ro.seq AS op_seq,
       COALESCE(ro.name, 'WIP') AS operation_name,
       wb.work_centre_id, wc.code AS work_centre_code,
       wb.machine_id, m.code AS machine_code,
       wb.product_id, p.code AS product_code, p.name AS product_name,
       wb.quantity, wb.last_posting_at
FROM wip_balances wb
JOIN work_orders wo ON wo.id = wb.work_order_id
LEFT JOIN routing_operations ro ON ro.id = wb.routing_operation_id
LEFT JOIN work_centres wc ON wc.id = wb.work_centre_id
LEFT JOIN machines m ON m.id = wb.machine_id
JOIN products p ON p.id = wb.product_id;

CREATE OR REPLACE VIEW v_material_reservation AS
SELECT pmr.id, pmr.reservation_no, pmr.work_order_id, wo.wo_no, pmr.product_id,
       p.code AS product_code, p.name AS product_name,
       pb.batch_no, w.code AS warehouse_code, pmr.required_qty, pmr.reserved_qty,
       pmr.issued_qty, pmr.consumed_qty, pmr.status,
       (pmr.issued_qty - pmr.consumed_qty) AS variance_qty,
       pmr.reserved_at, pmr.issued_at, pmr.consumed_at
FROM production_material_reservations pmr
JOIN work_orders wo ON wo.id = pmr.work_order_id
JOIN products p ON p.id = pmr.product_id
LEFT JOIN product_batches pb ON pb.id = pmr.batch_id
LEFT JOIN warehouses w ON w.id = pmr.warehouse_id;

CREATE OR REPLACE VIEW v_production_batch_ebr AS
SELECT pb.id, pb.batch_no, pb.status, pb.batch_date, pb.shift_code,
       pb.work_order_id, wo.wo_no, pb.product_id, p.code AS product_code, p.name AS product_name,
       pb.bom_version_id, bv.code AS bom_version_code,
       pb.routing_id, r.code AS routing_code,
       pb.machine_id, m.code AS machine_code,
       pb.quantity, pb.good_qty, pb.rejected_qty, pb.scrap_qty, pb.rework_qty,
       pb.quality_result, pb.started_at, pb.ended_at,
       pb.operators, pb.material_batches, pb.packaging, pb.pallet,
       pb.finished_goods_location, pb.ebr_json, pb.attributes
FROM production_batches pb
JOIN products p ON p.id = pb.product_id
LEFT JOIN work_orders wo ON wo.id = pb.work_order_id
LEFT JOIN bom_versions bv ON bv.id = pb.bom_version_id
LEFT JOIN routings r ON r.id = pb.routing_id
LEFT JOIN machines m ON m.id = pb.machine_id;

-- ---------- 23. Row-level security ----------
ALTER TABLE product_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_version_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_substitutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_co_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_operation_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_operation_quality_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE wip_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_material_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_material_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrap_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE downtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_quality_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rework_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcontract_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE changeover_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_shift_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_availability_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_variances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product_families USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON product_variants USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON bom_versions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON bom_version_lines USING (bom_version_id IN (SELECT id FROM bom_versions));
CREATE POLICY tenant_isolation ON bom_substitutes USING (bom_line_id IN (SELECT id FROM bom_version_lines));
CREATE POLICY tenant_isolation ON bom_co_products USING (bom_version_id IN (SELECT id FROM bom_versions));
CREATE POLICY tenant_isolation ON routing_operation_materials USING (routing_operation_id IN (SELECT id FROM routing_operations));
CREATE POLICY tenant_isolation ON routing_operation_quality_checks USING (routing_operation_id IN (SELECT id FROM routing_operations));
CREATE POLICY tenant_isolation ON work_instructions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON machine_capacity USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_batches USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON wip_balances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_material_reservations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_material_issues USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON scrap_records USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON waste_records USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON downtime_events USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_quality_holds USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON quality_dispositions USING (hold_id IN (SELECT id FROM production_quality_holds));
CREATE POLICY tenant_isolation ON rework_orders USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON subcontract_orders USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON changeover_logs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON machine_logs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_schedules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_schedule_entries USING (schedule_id IN (SELECT id FROM production_schedules));
CREATE POLICY tenant_isolation ON production_shift_handovers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON material_availability_checks USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_alerts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON manufacturing_events USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_documents USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_variances USING (tenant_id = app_tenant_id());
