-- ============================================================
-- 0002 Master data: products, units, BOM, routings, machines
-- ============================================================

CREATE TABLE product_categories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'FINISHED_GOODS'
    CHECK (kind IN ('RAW_MATERIAL','WIP','FINISHED_GOODS','PACKAGING','CONSUMABLE','SPARE_PART','SERVICE','SECURITY_ITEM')),
  parent_id BIGINT REFERENCES product_categories(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE units (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'COUNT' CHECK (kind IN ('COUNT','WEIGHT','VOLUME','LENGTH','AREA','DIMENSION')),
  base_unit_id BIGINT REFERENCES units(id),
  factor NUMERIC(18,6),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  category_id BIGINT REFERENCES product_categories(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  barcode TEXT,
  type TEXT NOT NULL DEFAULT 'FINISHED_GOODS'
    CHECK (type IN ('JUMBO_ROLL','PAPER_BOBBIN','SHEET','REAM','FINISHED_GOODS','PACKAGING','CONSUMABLE','SPARE_PART','SECURITY_ITEM','SERVICE')),
  unit_id BIGINT REFERENCES units(id),
  -- paper dimensions
  gsm NUMERIC(10,2),
  width_mm NUMERIC(12,2),
  roll_length_m NUMERIC(12,2),
  roll_diameter_mm NUMERIC(12,2),
  sheets_per_ream INTEGER,
  ream_weight_kg NUMERIC(12,4),
  weight_per_unit NUMERIC(12,4),
  -- costing
  valuation_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE' CHECK (valuation_method IN ('FIFO','WEIGHTED_AVERAGE')),
  standard_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  standard_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  -- planning
  reorder_point NUMERIC(18,4) NOT NULL DEFAULT 0,
  safety_stock NUMERIC(18,4) NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  lot_size NUMERIC(18,4),
  -- traceability
  is_tracked BOOLEAN NOT NULL DEFAULT true,
  is_serialized BOOLEAN NOT NULL DEFAULT false,
  security_classification TEXT NOT NULL DEFAULT 'NONE'
    CHECK (security_classification IN ('NONE','RESTRICTED','CONFIDENTIAL','SECRET')),
  shelf_life_days INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','DISCONTINUED')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_type ON products(company_id, type);
CREATE INDEX idx_products_code ON products(company_id, code);

CREATE TABLE product_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  supplier_id BIGINT,
  batch_no TEXT NOT NULL,
  lot_no TEXT,
  received_at TIMESTAMPTZ,
  expiry_date DATE,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','QUARANTINE','BLOCKED','EXPIRED','CONSUMED')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, product_id, batch_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_batches_product ON product_batches(product_id);
CREATE INDEX idx_batches_supplier ON product_batches(supplier_id);

CREATE TABLE serial_numbers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  serial_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ISSUED','SCRAPPED','VOID','RETURNED')),
  UNIQUE (company_id, serial_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- BOM ----------
CREATE TABLE boms (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_id BIGINT REFERENCES units(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','OBSOLETE')),
  UNIQUE (company_id, product_id, code, version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bom_items (
  id BIGSERIAL PRIMARY KEY,
  bom_id BIGINT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  scrap_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  is_consumable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Routings / work centres ----------
CREATE TABLE work_centres (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'MACHINE' CHECK (type IN ('MACHINE','LABOUR','ASSEMBLY','QC','PACKAGING')),
  capacity NUMERIC(18,4),
  capacity_unit TEXT,
  hourly_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  overhead_rate NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, product_id, code, version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routing_operations (
  id BIGSERIAL PRIMARY KEY,
  routing_id BIGINT NOT NULL REFERENCES routings(id) ON DELETE CASCADE,
  work_centre_id BIGINT NOT NULL REFERENCES work_centres(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  setup_time_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  run_time_per_unit_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  teardown_time_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  machine_id BIGINT,
  UNIQUE (routing_id, seq),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Machines ----------
CREATE TABLE machines (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  work_centre_id BIGINT REFERENCES work_centres(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  make TEXT,
  model TEXT,
  serial_no TEXT,
  type TEXT NOT NULL DEFAULT 'CUTTING'
    CHECK (type IN ('CUTTING','SLITTING','SHEET_CUTTER','PACKAGING','PRINTING','SECURITY_PRINTING','PACKING','GENERAL')),
  capacity NUMERIC(18,4),
  capacity_unit TEXT,
  hourly_rate NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPERATIONAL'
    CHECK (status IN ('OPERATIONAL','IDLE','MAINTENANCE','BREAKDOWN','OFFLINE')),
  is_secure BOOLEAN NOT NULL DEFAULT false,
  qr_id BIGINT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_machines_status ON machines(status);

CREATE TABLE machine_status_history (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  work_order_id BIGINT,
  changed_by BIGINT REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE boms ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE routings ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product_categories USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON units USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON products USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON product_batches USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON serial_numbers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON boms USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON bom_items USING (bom_id IN (SELECT id FROM boms));
CREATE POLICY tenant_isolation ON work_centres USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON routings USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON routing_operations USING (routing_id IN (SELECT id FROM routings));
CREATE POLICY tenant_isolation ON machines USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON machine_status_history USING (tenant_id = app_tenant_id());
