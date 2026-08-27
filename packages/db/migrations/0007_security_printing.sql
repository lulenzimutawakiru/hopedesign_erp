-- ============================================================
-- 0007 Security printing + chain of custody
-- ============================================================

CREATE TABLE security_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  job_no TEXT NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  sales_order_id BIGINT REFERENCES sales_orders(id),
  description TEXT NOT NULL,
  specification JSONB NOT NULL DEFAULT '{}'::jsonb,
  security_classification TEXT NOT NULL DEFAULT 'CONFIDENTIAL'
    CHECK (security_classification IN ('RESTRICTED','CONFIDENTIAL','SECRET')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT','SUBMITTED','APPROVED','MATERIALS_AUTHORIZED','MATERIALS_ISSUED',
      'IN_PRODUCTION','QC','RECONCILIATION','PACKAGING','IN_SECURE_STORAGE',
      'DISPATCHED','DELIVERED','ON_HOLD','REJECTED','CANCELLED')),
  quantity_planned NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_produced NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_spoiled NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_waste NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_rework NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_dispatched NUMERIC(18,4) NOT NULL DEFAULT 0,
  start_date DATE,
  due_date DATE,
  -- approvals (job approver must differ from creator)
  requested_by BIGINT NOT NULL REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  materials_authorized_by BIGINT REFERENCES users(id),
  materials_authorized_at TIMESTAMPTZ,
  materials_issued_by BIGINT REFERENCES users(id),
  materials_issued_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (company_id, job_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_secjobs_status ON security_jobs(status);

CREATE TABLE security_job_requirements (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES security_jobs(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity_required NUMERIC(18,4) NOT NULL,
  quantity_authorized NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_issued NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_returned NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_spoiled NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_id BIGINT REFERENCES units(id),
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  security_cleared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE security_job_operators (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES security_jobs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  UNIQUE (job_id, user_id)
);

CREATE TABLE security_job_machines (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES security_jobs(id) ON DELETE CASCADE,
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  UNIQUE (job_id, machine_id)
);

-- Chain of custody events (dual control: actor + witness)
CREATE TABLE secure_custody_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_id BIGINT NOT NULL REFERENCES security_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'JOB_CREATED','JOB_APPROVED','MATERIALS_AUTHORIZED','MATERIALS_ISSUED',
      'MACHINE_ASSIGNED','OPERATOR_ASSIGNED','PRODUCTION_STARTED','PRODUCTION_COMPLETED',
      'QC_PASSED','QC_FAILED','RECONCILIATION','PACKAGING','SECURE_STORAGE',
      'DISPATCH','DELIVERY','HOLD','RESUME')),
  from_user_id BIGINT REFERENCES users(id),
  to_user_id BIGINT REFERENCES users(id),
  witness_user_id BIGINT REFERENCES users(id),
  from_location TEXT,
  to_location TEXT,
  notes TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_custody_job ON secure_custody_events(job_id, occurred_at);

-- Material issue records for secure jobs (dual-signed)
CREATE TABLE secure_material_issues (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_id BIGINT NOT NULL REFERENCES security_jobs(id),
  requirement_id BIGINT REFERENCES security_job_requirements(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  quantity NUMERIC(18,4) NOT NULL,
  from_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  to_location TEXT,
  issued_by BIGINT NOT NULL REFERENCES users(id),
  verified_by BIGINT NOT NULL REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Production batches produced from a secure job
CREATE TABLE secure_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_id BIGINT NOT NULL REFERENCES security_jobs(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  batch_no TEXT NOT NULL,
  quantity_good NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_spoiled NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_waste NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_rework NUMERIC(18,4) NOT NULL DEFAULT 0,
  product_id BIGINT REFERENCES products(id),
  qc_result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (qc_result IN ('PENDING','PASSED','FAILED','QUARANTINED')),
  warehouse_id BIGINT REFERENCES warehouses(id),
  qr_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconciliation: issued vs output vs spoilage vs waste
CREATE TABLE secure_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_id BIGINT NOT NULL REFERENCES security_jobs(id) ON DELETE CASCADE,
  material_product_id BIGINT NOT NULL REFERENCES products(id),
  quantity_issued NUMERIC(18,4) NOT NULL,
  quantity_output NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_spoiled NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_waste NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_returned NUMERIC(18,4) NOT NULL DEFAULT 0,
  variance NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_VESTIGATION','RECONCILED','CLOSED')),
  reconciled_by BIGINT REFERENCES users(id),
  second_checker_id BIGINT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE security_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_job_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_job_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_job_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure_custody_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure_material_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON security_jobs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON security_job_requirements USING (job_id IN (SELECT id FROM security_jobs));
CREATE POLICY tenant_isolation ON security_job_operators USING (job_id IN (SELECT id FROM security_jobs));
CREATE POLICY tenant_isolation ON security_job_machines USING (job_id IN (SELECT id FROM security_jobs));
CREATE POLICY tenant_isolation ON secure_custody_events USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON secure_material_issues USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON secure_batches USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON secure_reconciliations USING (tenant_id = app_tenant_id());
