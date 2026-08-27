-- ============================================================
-- 0011 HR, Assets, Documents
-- ============================================================

CREATE TABLE employees (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  user_id BIGINT REFERENCES users(id),
  employee_no TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT,
  dob DATE,
  national_id TEXT,
  tin TEXT,
  nssf_no TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  position TEXT,
  hire_date DATE,
  termination_date DATE,
  salary_type TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (salary_type IN ('MONTHLY','HOURLY','COMMISSION')),
  base_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  bank_name TEXT,
  bank_account_no TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ON_LEAVE','SUSPENDED','TERMINATED','PROBATION')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, employee_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employment_contracts (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_type TEXT NOT NULL DEFAULT 'PERMANENT'
    CHECK (contract_type IN ('PERMANENT','CONTRACT','PROBATION','PART_TIME','CASUAL')),
  start_date DATE NOT NULL,
  end_date DATE,
  salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  allowances JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','TERMINATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  hours NUMERIC(6,2),
  status TEXT NOT NULL DEFAULT 'PRESENT'
    CHECK (status IN ('PRESENT','ABSENT','LEAVE','HOLIDAY','HALF_DAY')),
  notes TEXT,
  UNIQUE (employee_id, work_date),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leave_requests (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  leave_type TEXT NOT NULL DEFAULT 'ANNUAL'
    CHECK (leave_type IN ('ANNUAL','SICK','MATERNITY','PATERNITY','UNPAID','STUDY','COMPASSIONATE')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(6,2) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payrolls (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_no TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','RELEASED','PAID','VOID')),
  gross_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  released_by BIGINT,
  released_at TIMESTAMPTZ,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  created_by BIGINT,
  UNIQUE (company_id, payroll_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payroll_items (
  id BIGSERIAL PRIMARY KEY,
  payroll_id BIGINT NOT NULL REFERENCES payrolls(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  basic_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  allowances NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  paye NUMERIC(18,2) NOT NULL DEFAULT 0,
  nssf NUMERIC(18,2) NOT NULL DEFAULT 0,
  loans NUMERIC(18,2) NOT NULL DEFAULT 0,
  advances NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  payslip_no TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_loans (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  amount NUMERIC(18,2) NOT NULL,
  balance NUMERIC(18,2) NOT NULL,
  monthly_deduction NUMERIC(18,2) NOT NULL DEFAULT 0,
  start_date DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAID','WRITTEN_OFF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Assets ----------
CREATE TABLE asset_categories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  depreciation_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE'
    CHECK (depreciation_method IN ('STRAIGHT_LINE','REDUCING_BALANCE','NONE')),
  default_life_years INTEGER NOT NULL DEFAULT 5,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  category_id BIGINT REFERENCES asset_categories(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  serial_no TEXT,
  purchase_date DATE,
  purchase_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  useful_life_years INTEGER NOT NULL DEFAULT 5,
  depreciation_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  accumulated_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0,
  salvage_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  custodian_user_id BIGINT,
  location TEXT,
  gl_asset_account_id BIGINT,
  status TEXT NOT NULL DEFAULT 'IN_USE'
    CHECK (status IN ('IN_USE','IN_STORE','MAINTENANCE','DISPOSED','WRITTEN_OFF')),
  qr_id BIGINT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_movements (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  from_user_id BIGINT,
  to_user_id BIGINT,
  from_location TEXT,
  to_location TEXT,
  reason TEXT,
  moved_by BIGINT REFERENCES users(id),
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_maintenance (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  maintenance_type TEXT NOT NULL DEFAULT 'SERVICE',
  maintenance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  performed_by TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Documents ----------
CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  doc_no TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  checksum TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','ARCHIVED','EXPIRED')),
  uploaded_by BIGINT REFERENCES users(id),
  expires_at DATE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, doc_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  checksum TEXT,
  uploaded_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE document_links (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, entity_type, entity_id)
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON employees USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON employment_contracts USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON attendance USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON leave_requests USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON payrolls USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON payroll_items USING (payroll_id IN (SELECT id FROM payrolls));
CREATE POLICY tenant_isolation ON employee_loans USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON asset_categories USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON assets USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON asset_movements USING (asset_id IN (SELECT id FROM assets));
CREATE POLICY tenant_isolation ON asset_maintenance USING (asset_id IN (SELECT id FROM assets));
CREATE POLICY tenant_isolation ON documents USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON document_versions USING (document_id IN (SELECT id FROM documents));
CREATE POLICY tenant_isolation ON document_links USING (document_id IN (SELECT id FROM documents));
