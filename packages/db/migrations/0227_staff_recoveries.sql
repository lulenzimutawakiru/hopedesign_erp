-- Staff loans, salary advances and fines.
-- A request is approved by someone else, paid out to the receivable,
-- then recovered on payroll. Leave types gain the statutory Uganda minima
-- where the company does not already have that code.

ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS fines NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE employee_loans
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS repayment_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS interest_outstanding NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disbursed_by BIGINT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS gl_journal_id BIGINT;

ALTER TABLE salary_advances
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disbursed_by BIGINT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS gl_journal_id BIGINT;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS requested_by BIGINT;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = 'employee_loans' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE employee_loans DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = 'salary_advances' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE salary_advances DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE employee_loans ADD CONSTRAINT employee_loans_status_check
  CHECK (status IN ('PENDING','APPROVED','ACTIVE','PAUSED','CLOSED','REJECTED','WRITTEN_OFF','PAID'));

ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_status_check
  CHECK (status IN ('PENDING','APPROVED','ACTIVE','PAID','CLOSED','REJECTED','WAIVED'));

CREATE TABLE IF NOT EXISTS employee_fines (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  disciplinary_case_id BIGINT REFERENCES disciplinary_cases(id),
  fine_no TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  outstanding_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  monthly_deduction NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  incident_date DATE,
  requested_by BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  gl_journal_id BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','ACTIVE','PAID','REJECTED','WAIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, fine_no)
);
CREATE INDEX IF NOT EXISTS idx_employee_fines_emp ON employee_fines(employee_id, status);

CREATE TABLE IF NOT EXISTS fine_recoveries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  fine_id BIGINT NOT NULL REFERENCES employee_fines(id) ON DELETE CASCADE,
  payroll_run_id BIGINT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fine_id, payroll_run_id)
);
CREATE INDEX IF NOT EXISTS idx_fine_recoveries_fine ON fine_recoveries(fine_id);

ALTER TABLE employee_fines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fine_recoveries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'employee_fines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON employee_fines USING (tenant_id = app_tenant_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fine_recoveries' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON fine_recoveries USING (tenant_id = app_tenant_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_employee_fines') THEN
    CREATE TRIGGER trg_audit_employee_fines AFTER INSERT OR UPDATE OR DELETE ON employee_fines
      FOR EACH ROW EXECUTE FUNCTION audit_row();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_fine_recoveries') THEN
    CREATE TRIGGER trg_audit_fine_recoveries AFTER INSERT OR UPDATE OR DELETE ON fine_recoveries
      FOR EACH ROW EXECUTE FUNCTION audit_row();
  END IF;
END $$;

-- Statutory minima. Existing codes are left as the company configured them.
INSERT INTO leave_types (
  company_id, tenant_id, code, name, category, days_per_year, max_consecutive_days,
  carryover_limit, is_paid, requires_approval, status
)
SELECT c.id, c.tenant_id, v.code, v.name, v.category, v.days_per_year, v.max_consecutive,
       0, v.is_paid, true, 'ACTIVE'
FROM companies c
CROSS JOIN (VALUES
  ('ANNUAL', 'Annual leave', 'ANNUAL', 21::numeric, 21::numeric, true),
  ('SICK', 'Sick leave', 'SICK', 44::numeric, 44::numeric, true),
  ('MATERNITY', 'Maternity leave', 'MATERNITY', 60::numeric, 60::numeric, true),
  ('PATERNITY', 'Paternity leave', 'PATERNITY', 4::numeric, 4::numeric, true),
  ('COMPASSIONATE', 'Compassionate leave', 'COMPASSIONATE', 6::numeric, 3::numeric, true),
  ('UNPAID', 'Unpaid leave', 'UNPAID', NULL::numeric, NULL::numeric, false)
) AS v(code, name, category, days_per_year, max_consecutive, is_paid)
WHERE NOT EXISTS (
  SELECT 1 FROM leave_types t WHERE t.company_id = c.id AND t.code = v.code
);

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'hr', 'fines', v.action, v.description
FROM (VALUES
  ('hr.fines.view', 'view', 'View staff fines'),
  ('hr.fines.create', 'create', 'Raise a staff fine'),
  ('hr.fines.approve', 'approve', 'Approve a staff fine'),
  ('hr.fines.waive', 'waive', 'Waive a staff fine')
) AS v(code, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions held ON held.id = rp.permission_id AND held.code = 'hr.loans.create'
JOIN permissions p ON p.code LIKE 'hr.fines.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.fines.view', 'hr.fines.approve')
WHERE r.code = 'payroll_manager'
ON CONFLICT (role_id, permission_id) DO NOTHING;
