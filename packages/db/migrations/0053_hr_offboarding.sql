-- ============================================================
-- 0053 HR/HCM - Offboarding, exit clearance, alumni + lifecycle movements
-- Complements the existing HR lifecycle: hire -> onboard -> work -> exit -> alumni
-- ============================================================

-- ---------- Offboarding checklist templates ----------
CREATE TABLE offboarding_checklists (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offboarding_tasks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  checklist_id BIGINT NOT NULL REFERENCES offboarding_checklists(id) ON DELETE CASCADE,
  task_no TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'CLEARANCE'
    CHECK (category IN ('ASSET_RETURN','FINANCE_CLEARANCE','DOCUMENT_RETURN','EXIT_INTERVIEW',
                        'IT_ACCESS','FINAL_SETTLEMENT','LEGAL','CLEARANCE','OTHER')),
  description TEXT,
  due_days INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (checklist_id, task_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Offboarding instances (one per employee exit) ----------
CREATE TABLE offboarding_instances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  checklist_id BIGINT NOT NULL REFERENCES offboarding_checklists(id),
  instance_no TEXT NOT NULL,
  offboarding_type TEXT NOT NULL DEFAULT 'RESIGNATION'
    CHECK (offboarding_type IN ('RESIGNATION','TERMINATION','RETIREMENT','REDUNDANCY',
                                'END_OF_CONTRACT','TRANSFER','OTHER')),
  effective_date DATE NOT NULL,
  last_working_date DATE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','CLEARED','COMPLETED','CANCELLED')),
  exit_interview_notes TEXT,
  final_settlement_required BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, instance_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_offboarding_employee ON offboarding_instances(employee_id);
CREATE INDEX idx_offboarding_status ON offboarding_instances(tenant_id, status);

CREATE TABLE offboarding_instance_tasks (
  id BIGSERIAL PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES offboarding_instances(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES offboarding_tasks(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','WAIVED')),
  completed_by BIGINT,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (instance_id, task_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Employee alumni / exit fields ----------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS alumni_date DATE,
  ADD COLUMN IF NOT EXISTS offboarding_type TEXT,
  ADD COLUMN IF NOT EXISTS exit_reason TEXT,
  ADD COLUMN IF NOT EXISTS rehire_eligible BOOLEAN NOT NULL DEFAULT true;

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('offboarding_checklists','offboarding_tasks',
                         'offboarding_instances','offboarding_instance_tasks')
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

-- ---------- Row-level security (tenant isolation at the database) ----------
ALTER TABLE offboarding_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_instance_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offboarding_checklists USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON offboarding_tasks USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON offboarding_instances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON offboarding_instance_tasks USING (instance_id IN (SELECT id FROM offboarding_instances));

-- ---------- DB-level audit triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['offboarding_checklists','offboarding_tasks',
                           'offboarding_instances','offboarding_instance_tasks']
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