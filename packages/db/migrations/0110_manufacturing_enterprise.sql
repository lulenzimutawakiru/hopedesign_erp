-- ============================================================
-- 0110 - Manufacturing enterprise extensions
-- Production standards, packaging hierarchy, work-centre targets
-- ============================================================

-- ------------------------------------------------------------
-- Production standards: configurable setup/run/labour/output/waste
-- for each product (used by planning, costing and MES baselines).
-- ------------------------------------------------------------
CREATE TABLE production_standards (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  version INTEGER NOT NULL DEFAULT 1,
  standard_setup_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  standard_run_min_per_unit NUMERIC(10,4) NOT NULL DEFAULT 0,
  standard_labour_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  expected_output NUMERIC(18,4),
  expected_waste_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  waste_tolerance_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  standard_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  cost_rate NUMERIC(18,4) NOT NULL DEFAULT 0,
  quality_checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_production_standards_product ON production_standards(product_id, is_active);
ALTER TABLE production_standards ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Packaging hierarchy: configurable Sheet -> Ream -> Carton -> Pallet
-- ------------------------------------------------------------
CREATE TABLE packaging_hierarchies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  level INTEGER NOT NULL DEFAULT 1,
  level_code TEXT NOT NULL,
  name TEXT NOT NULL,
  qty_per_parent NUMERIC(18,4) NOT NULL DEFAULT 1,
  weight_kg NUMERIC(18,4),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, product_id, level),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_packaging_hierarchy_product ON packaging_hierarchies(product_id);
ALTER TABLE packaging_hierarchies ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Work centre planning targets and shift configuration
-- ------------------------------------------------------------
ALTER TABLE work_centres
  ADD COLUMN IF NOT EXISTS department TEXT,
  ADD COLUMN IF NOT EXISTS available_hours NUMERIC(10,2) NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS efficiency_target NUMERIC(8,4) NOT NULL DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS utilisation_target NUMERIC(8,4) NOT NULL DEFAULT 0.80,
  ADD COLUMN IF NOT EXISTS shift_config JSONB NOT NULL DEFAULT '[]'::jsonb;

-- RLS policies for new tables
CREATE POLICY tenant_isolation ON production_standards USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON packaging_hierarchies USING (tenant_id = app_tenant_id());
