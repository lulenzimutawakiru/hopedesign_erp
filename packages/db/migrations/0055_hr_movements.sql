-- ============================================================
-- 0055 HR/HCM - Employee movements + salary history
-- Supports promotions, transfers, secondments and versioned salary changes
-- consumed by Payroll (HR -> Payroll change control).
-- ============================================================

CREATE TABLE employee_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('PROMOTION','TRANSFER','SECONDMENT','DEMOTION','ROTATION')),
  from_position_id BIGINT REFERENCES positions(id),
  to_position_id BIGINT REFERENCES positions(id),
  effective_from DATE NOT NULL,
  effective_to DATE,
  old_salary NUMERIC(14,2),
  new_salary NUMERIC(14,2),
  reason TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_movements_employee ON employee_movements(employee_id, effective_from);
CREATE INDEX idx_employee_movements_tenant ON employee_movements(tenant_id, company_id, movement_type);

CREATE TABLE salary_histories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  old_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  new_salary NUMERIC(14,2) NOT NULL,
  effective_date DATE NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'HR' CHECK (source IN ('HR','PAYROLL','OFFBOARDING','IMPORT')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_salary_histories_employee ON salary_histories(employee_id, effective_date);
CREATE INDEX idx_salary_histories_tenant ON salary_histories(tenant_id, company_id);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('employee_movements','salary_histories')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at'
        AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- Row-level security (tenant isolation at the database)
ALTER TABLE employee_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_histories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_movements USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON salary_histories USING (tenant_id = app_tenant_id());

-- DB-level audit triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_movements','salary_histories']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit'
        AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;
