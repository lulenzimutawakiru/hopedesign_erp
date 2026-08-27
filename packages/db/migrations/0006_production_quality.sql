-- ============================================================
-- 0006 Production + Quality
-- ============================================================

CREATE TABLE production_plans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  plan_no TEXT NOT NULL,
  plan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start DATE,
  period_end DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','IN_EXECUTION','COMPLETED','CANCELLED')),
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, plan_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_plan_items (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  wo_no TEXT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  bom_id BIGINT REFERENCES boms(id),
  routing_id BIGINT REFERENCES routings(id),
  plan_id BIGINT REFERENCES production_plans(id),
  plan_item_id BIGINT REFERENCES production_plan_items(id),
  sales_order_id BIGINT REFERENCES sales_orders(id),
  sales_order_item_id BIGINT REFERENCES sales_order_items(id),
  batch_id BIGINT REFERENCES product_batches(id),
  quantity NUMERIC(18,4) NOT NULL,
  produced_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  scrapped_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  rework_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  waste_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','RELEASED','IN_PROGRESS','ON_HOLD','COMPLETED','CLOSED','REJECTED','CANCELLED')),
  security_classification TEXT NOT NULL DEFAULT 'NONE'
    CHECK (security_classification IN ('NONE','RESTRICTED','CONFIDENTIAL','SECRET')),
  start_date DATE,
  due_date DATE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  machine_id BIGINT REFERENCES machines(id),
  operator_id BIGINT,
  -- costing
  standard_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_material_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_labour_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_machine_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_overhead_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_waste_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_other_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  cost_variance NUMERIC(18,4) NOT NULL DEFAULT 0,
  yield_percent NUMERIC(8,4),
  efficiency_percent NUMERIC(8,4),
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  released_by BIGINT,
  released_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, wo_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_product ON work_orders(product_id);
CREATE INDEX idx_wo_so ON work_orders(sales_order_id);

CREATE TABLE work_order_materials (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  required_qty NUMERIC(18,4) NOT NULL,
  issued_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  returned_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  is_consumable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_order_operations (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  routing_operation_id BIGINT,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  work_centre_id BIGINT REFERENCES work_centres(id),
  machine_id BIGINT REFERENCES machines(id),
  planned_setup_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  planned_run_min NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_started_at TIMESTAMPTZ,
  actual_ended_at TIMESTAMPTZ,
  operator_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_order_labour (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  operator_user_id BIGINT REFERENCES users(id),
  hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  hourly_rate NUMERIC(18,4) NOT NULL DEFAULT 0,
  cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  worked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_outputs (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  output_type TEXT NOT NULL CHECK (output_type IN ('GOOD','SCRAP','REWORK','WASTE')),
  quantity NUMERIC(18,4) NOT NULL,
  batch_id BIGINT REFERENCES product_batches(id),
  qr_id BIGINT,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  reason TEXT,
  recorded_by BIGINT REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_downtime (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT REFERENCES work_orders(id) ON DELETE CASCADE,
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  downtime_type TEXT NOT NULL
    CHECK (downtime_type IN ('BREAKDOWN','PREVENTIVE_MAINTENANCE','CORRECTIVE_MAINTENANCE','SETUP','MATERIAL_SHORTAGE','OPERATOR','POWER','QUALITY','OTHER')),
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  minutes INTEGER,
  recorded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Quality ----------
CREATE TABLE inspection_plans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'FINAL' CHECK (kind IN ('INCOMING','IN_PROCESS','FINAL')),
  parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inspections (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  inspection_no TEXT NOT NULL,
  plan_id BIGINT REFERENCES inspection_plans(id),
  kind TEXT NOT NULL DEFAULT 'FINAL' CHECK (kind IN ('INCOMING','IN_PROCESS','FINAL')),
  ref_type TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  quantity NUMERIC(18,4),
  sampled_qty NUMERIC(18,4),
  result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (result IN ('PENDING','PASSED','FAILED','QUARANTINED','IN_PROGRESS')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','CLOSED','CANCELLED')),
  inspector_id BIGINT REFERENCES users(id),
  inspected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, inspection_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inspection_results (
  id BIGSERIAL PRIMARY KEY,
  inspection_id BIGINT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  parameter TEXT NOT NULL,
  method TEXT,
  standard_value TEXT,
  actual_value TEXT,
  unit TEXT,
  passed BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE defects (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  ref_type TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  defect_type TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'MINOR' CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  disposition TEXT NOT NULL DEFAULT 'REWORK'
    CHECK (disposition IN ('REWORK','SCRAP','ACCEPT','REJECT')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ncrs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  ncr_no TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  product_id BIGINT REFERENCES products(id),
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MAJOR' CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','INVESTIGATING','CAPA_REQUIRED','CLOSED')),
  root_cause TEXT,
  corrective_action TEXT,
  preventive_action TEXT,
  opened_by BIGINT REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT,
  closed_at TIMESTAMPTZ,
  UNIQUE (company_id, ncr_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capa (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  capa_no TEXT NOT NULL,
  ncr_id BIGINT REFERENCES ncrs(id),
  capa_type TEXT NOT NULL DEFAULT 'CORRECTIVE' CHECK (capa_type IN ('CORRECTIVE','PREVENTIVE')),
  description TEXT NOT NULL,
  action_plan TEXT,
  owner_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','IMPLEMENTED','VERIFIED','CLOSED')),
  due_date DATE,
  effectiveness TEXT,
  closed_at TIMESTAMPTZ,
  UNIQUE (company_id, capa_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE production_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_labour ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_downtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE defects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ncrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capa ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON production_plans USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_plan_items USING (plan_id IN (SELECT id FROM production_plans));
CREATE POLICY tenant_isolation ON work_orders USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON work_order_materials USING (work_order_id IN (SELECT id FROM work_orders));
CREATE POLICY tenant_isolation ON work_order_operations USING (work_order_id IN (SELECT id FROM work_orders));
CREATE POLICY tenant_isolation ON work_order_labour USING (work_order_id IN (SELECT id FROM work_orders));
CREATE POLICY tenant_isolation ON production_outputs USING (work_order_id IN (SELECT id FROM work_orders));
CREATE POLICY tenant_isolation ON production_downtime USING (work_order_id IN (SELECT id FROM work_orders));
CREATE POLICY tenant_isolation ON inspection_plans USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inspections USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON inspection_results USING (inspection_id IN (SELECT id FROM inspections));
CREATE POLICY tenant_isolation ON defects USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON ncrs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON capa USING (tenant_id = app_tenant_id());
