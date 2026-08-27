-- ============================================================
-- 0023 Enterprise Payroll Module
-- Tenant + company + branch scoped, configurable statutory engine,
-- effective-dated salary data, immutable closed payroll, 4-eyes approval.
-- ============================================================

-- ---------- Payroll groups ----------
CREATE TABLE payroll_groups (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (frequency IN ('MONTHLY','WEEKLY','BIWEEKLY','SEMIMONTHLY','DAILY','CUSTOM')),
  salary_currency TEXT NOT NULL DEFAULT 'UGX',
  default_payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (default_payment_method IN ('BANK_TRANSFER','MOBILE_MONEY','CASH','OTHER')),
  overtime_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  statutory_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Payroll calendars ----------
CREATE TABLE payroll_calendars (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (frequency IN ('MONTHLY','WEEKLY','BIWEEKLY','SEMIMONTHLY','DAILY','CUSTOM')),
  cutoff_day INT NOT NULL DEFAULT 25 CHECK (cutoff_day BETWEEN 1 AND 31),
  processing_day INT NOT NULL DEFAULT 27 CHECK (processing_day BETWEEN 1 AND 31),
  approval_deadline_day INT NOT NULL DEFAULT 28 CHECK (approval_deadline_day BETWEEN 1 AND 31),
  payment_day INT NOT NULL DEFAULT 31 CHECK (payment_day BETWEEN 1 AND 31),
  payslip_day INT NOT NULL DEFAULT 31 CHECK (payslip_day BETWEEN 1 AND 31),
  custom_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Payroll periods ----------
CREATE TABLE payroll_periods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  payroll_group_id BIGINT NOT NULL REFERENCES payroll_groups(id),
  calendar_id BIGINT REFERENCES payroll_calendars(id),
  code TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  cutoff_date DATE,
  processing_date DATE,
  approval_deadline DATE,
  payment_date DATE,
  payslip_publish_date DATE,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  period_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (period_type IN ('NORMAL','OFF_CYCLE','FINAL','ADJUSTMENT','REVERSAL','ARREARS')),
  reference_period_id BIGINT REFERENCES payroll_periods(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, payroll_group_id, code),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_payroll_periods_group ON payroll_periods(payroll_group_id);
CREATE INDEX idx_payroll_periods_company_dates ON payroll_periods(company_id, period_start, period_end);

-- ---------- Salary components ----------
CREATE TABLE salary_components (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  component_type TEXT NOT NULL
    CHECK (component_type IN ('EARNING','DEDUCTION','STATUTORY')),
  calculation_method TEXT NOT NULL DEFAULT 'FIXED'
    CHECK (calculation_method IN ('FIXED','PERCENTAGE','FORMULA','GRADE','DEPARTMENT','EMPLOYEE','CONDITIONAL')),
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  formula TEXT,
  base_component_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  taxable BOOLEAN NOT NULL DEFAULT true,
  statutory BOOLEAN NOT NULL DEFAULT false,
  employer_contribution BOOLEAN NOT NULL DEFAULT false,
  apply_on TEXT NOT NULL DEFAULT 'EARNINGS'
    CHECK (apply_on IN ('EARNINGS','DEDUCTIONS','BOTH')),
  effective_from DATE NOT NULL DEFAULT '2026-01-01',
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- ---------- Salary structures ----------
CREATE TABLE salary_structures (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE salary_structure_lines (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  structure_id BIGINT NOT NULL REFERENCES salary_structures(id) ON DELETE CASCADE,
  component_id BIGINT NOT NULL REFERENCES salary_components(id),
  seq INT NOT NULL DEFAULT 0,
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  formula TEXT,
  is_employer_contribution BOOLEAN NOT NULL DEFAULT false,
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (structure_id, component_id)
);
CREATE INDEX idx_salary_structure_lines_struct ON salary_structure_lines(structure_id);

-- ---------- Payroll settings (consumed by services; never hard-coded) ----------
CREATE TABLE payroll_settings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, config_key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Payroll GL mappings (component -> debit/credit) ----------
CREATE TABLE payroll_gl_mappings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_group_id BIGINT REFERENCES payroll_groups(id),
  component_id BIGINT REFERENCES salary_components(id),
  debit_account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  credit_account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  effective_from DATE NOT NULL DEFAULT '2026-01-01',
  effective_to DATE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, payroll_group_id, component_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_payroll_gl_mappings_company ON payroll_gl_mappings(company_id, component_id);

-- ---------- Employee payroll profiles ----------
CREATE TABLE employee_payroll_profiles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_group_id BIGINT REFERENCES payroll_groups(id),
  calendar_id BIGINT REFERENCES payroll_calendars(id),
  salary_structure_id BIGINT REFERENCES salary_structures(id),
  pay_grade_id BIGINT,
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  gl_account_id BIGINT REFERENCES chart_of_accounts(id),
  payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (payment_method IN ('BANK_TRANSFER','MOBILE_MONEY','CASH','OTHER')),
  bank_name TEXT,
  bank_account_no TEXT,
  mobile_money_no TEXT,
  currency TEXT NOT NULL DEFAULT 'UGX',
  tax_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  statutory_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','ON_LEAVE','TERMINATED','PENDING_CLOSURE')),
  status_reason TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id)
);
CREATE INDEX idx_emp_payroll_profiles_group ON employee_payroll_profiles(payroll_group_id);
CREATE INDEX idx_emp_payroll_profiles_cc ON employee_payroll_profiles(cost_centre_id);

-- ---------- Effective-dated employee salaries ----------
CREATE TABLE employee_salaries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  salary_structure_id BIGINT REFERENCES salary_structures(id),
  basic_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  effective_from DATE NOT NULL,
  effective_to DATE,
  is_current BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (basic_salary >= 0)
);
CREATE INDEX idx_employee_salaries_emp ON employee_salaries(employee_id, effective_from DESC);
CREATE UNIQUE INDEX uq_employee_salaries_current ON employee_salaries(employee_id) WHERE is_current = true;

-- ---------- Employee-specific earnings (overrides / additions) ----------
CREATE TABLE employee_earnings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  component_id BIGINT REFERENCES salary_components(id),
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  formula TEXT,
  taxable BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE NOT NULL DEFAULT '2026-01-01',
  effective_to DATE,
  is_current BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_employee_earnings_emp ON employee_earnings(employee_id, effective_from);

-- ---------- Employee-specific deductions ----------
CREATE TABLE employee_deductions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  component_id BIGINT REFERENCES salary_components(id),
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  formula TEXT,
  effective_from DATE NOT NULL DEFAULT '2026-01-01',
  effective_to DATE,
  is_current BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_employee_deductions_emp ON employee_deductions(employee_id, effective_from);

-- ---------- Employee benefits ----------
CREATE TABLE employee_benefits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  benefit_type TEXT NOT NULL,
  name TEXT NOT NULL,
  employer_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  employee_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT false,
  recurrence TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (recurrence IN ('MONTHLY','ONE_TIME','ANNUAL')),
  eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from DATE NOT NULL DEFAULT '2026-01-01',
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','EXPIRED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_employee_benefits_emp ON employee_benefits(employee_id);

-- ---------- Overtime records (approved only enters payroll) ----------
CREATE TABLE overtime_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  overtime_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (overtime_type IN ('NORMAL','WEEKEND','PUBLIC_HOLIDAY','NIGHT','SHIFT')),
  overtime_date DATE NOT NULL,
  hours NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  multiplier NUMERIC(6,2) NOT NULL DEFAULT 1.5,
  rate_base TEXT NOT NULL DEFAULT 'HOURLY' CHECK (rate_base IN ('HOURLY','BASIC','GROSS')),
  unit_amount NUMERIC(18,2),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT,
  requested_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  payroll_run_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_overtime_emp ON overtime_records(employee_id, overtime_date);
CREATE INDEX idx_overtime_status ON overtime_records(status);

-- ---------- Bonuses ----------
CREATE TABLE bonus_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  bonus_type TEXT NOT NULL DEFAULT 'PERFORMANCE'
    CHECK (bonus_type IN ('PERFORMANCE','ANNUAL','SALES','PRODUCTION','ATTENDANCE','REFERRAL','ONE_TIME','OTHER')),
  reason TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  payroll_period_id BIGINT REFERENCES payroll_periods(id),
  formula JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bonus_emp ON bonus_records(employee_id);
CREATE INDEX idx_bonus_period ON bonus_records(payroll_period_id);

-- ---------- Commissions ----------
CREATE TABLE commission_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  commission_type TEXT NOT NULL DEFAULT 'SALES',
  basis TEXT,
  rate NUMERIC(8,4),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  period_start DATE,
  period_end DATE,
  payroll_period_id BIGINT REFERENCES payroll_periods(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_commission_emp ON commission_records(employee_id);

-- ---------- Employee loans ----------
-- employee_loans exists from 0011; extend it with enterprise payroll fields (no data loss)
ALTER TABLE employee_loans
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS loan_no TEXT,
  ADD COLUMN IF NOT EXISTS principal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (principal >= 0),
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tenure_months INT NOT NULL DEFAULT 1 CHECK (tenure_months >= 1),
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reschedule_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS applied_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE employee_loans DROP CONSTRAINT IF EXISTS employee_loans_status_check;
ALTER TABLE employee_loans ADD CONSTRAINT employee_loans_status_check
  CHECK (status IN ('PENDING','ACTIVE','PAUSED','CLOSED','WRITTEN_OFF','PAID'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_loans_company_loan_no
  ON employee_loans(company_id, loan_no) WHERE loan_no IS NOT NULL;
CREATE INDEX idx_loans_emp ON employee_loans(employee_id, status);

CREATE TABLE loan_repayments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  loan_id BIGINT NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  payroll_run_id BIGINT,
  period_code TEXT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  principal_component NUMERIC(18,2) NOT NULL DEFAULT 0,
  interest_component NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loan_id, payroll_run_id)
);
CREATE INDEX idx_loan_repayments_loan ON loan_repayments(loan_id);

-- ---------- Salary advances ----------
CREATE TABLE salary_advances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  advance_no TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  monthly_deduction NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  outstanding_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  requested_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','PAID','CLOSED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, advance_no)
);
CREATE INDEX idx_advances_emp ON salary_advances(employee_id, status);

CREATE TABLE advance_repayments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  advance_id BIGINT NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  payroll_run_id BIGINT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (advance_id, payroll_run_id)
);
CREATE INDEX idx_advance_repayments_adv ON advance_repayments(advance_id);

-- ---------- Statutory rules (config-driven, versioned; NOT hard-coded) ----------
CREATE TABLE statutory_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'TAX'
    CHECK (category IN ('TAX','SOCIAL_SECURITY','OTHER')),
  country TEXT NOT NULL DEFAULT 'UG',
  currency TEXT NOT NULL DEFAULT 'UGX',
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE statutory_rule_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  statutory_rule_id BIGINT NOT NULL REFERENCES statutory_rules(id) ON DELETE CASCADE,
  version_code TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (statutory_rule_id, version_code),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_statutory_versions_rule ON statutory_rule_versions(statutory_rule_id, effective_from DESC);
CREATE UNIQUE INDEX uq_statutory_version_current ON statutory_rule_versions(statutory_rule_id) WHERE is_current = true;

-- ---------- Tax brackets (banded tax engine data) ----------
CREATE TABLE tax_brackets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  statutory_version_id BIGINT NOT NULL REFERENCES statutory_rule_versions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  lower_limit NUMERIC(18,2) NOT NULL DEFAULT 0,
  upper_limit NUMERIC(18,2),
  rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  cumulative_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  relief NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_free_threshold NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (statutory_version_id, seq),
  CHECK (upper_limit IS NULL OR upper_limit > lower_limit)
);
CREATE INDEX idx_tax_brackets_version ON tax_brackets(statutory_version_id, seq);

-- ---------- Employee tax profiles ----------
CREATE TABLE employee_tax_profiles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  tax_number TEXT,
  tax_authority TEXT DEFAULT 'URA',
  reliefs JSONB NOT NULL DEFAULT '[]'::jsonb,
  exemptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  filing_frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  default_statutory_version_id BIGINT REFERENCES statutory_rule_versions(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id)
);

-- ---------- Detailed statutory calculations (band-by-band breakdown) ----------
CREATE TABLE statutory_calculations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT,
  run_employee_id BIGINT,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  statutory_rule_id BIGINT NOT NULL REFERENCES statutory_rules(id),
  statutory_version_id BIGINT NOT NULL REFERENCES statutory_rule_versions(id),
  rule_code TEXT NOT NULL,
  taxable_base NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_taxable NUMERIC(18,2) NOT NULL DEFAULT 0,
  relief NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  employee_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id, rule_code)
);
CREATE INDEX idx_stat_calc_run ON statutory_calculations(payroll_run_id);
CREATE INDEX idx_stat_calc_emp ON statutory_calculations(employee_id);

-- ---------- Statutory submissions / filings ----------
CREATE TABLE statutory_submissions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  statutory_rule_id BIGINT NOT NULL REFERENCES statutory_rules(id),
  statutory_version_id BIGINT REFERENCES statutory_rule_versions(id),
  filing_no TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  employee_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  due_date DATE,
  submitted_at TIMESTAMPTZ,
  submitted_by BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED','PAID','LATE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stat_submissions_company ON statutory_submissions(company_id, period_start, period_end);

-- ---------- Payroll runs ----------
CREATE TABLE payroll_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  run_no TEXT NOT NULL,
  period_id BIGINT NOT NULL REFERENCES payroll_periods(id),
  payroll_group_id BIGINT NOT NULL REFERENCES payroll_groups(id),
  calendar_id BIGINT REFERENCES payroll_calendars(id),
  run_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (run_type IN ('NORMAL','OFF_CYCLE','FINAL','ADJUSTMENT','REVERSAL','ARREARS')),
  reference_run_id BIGINT REFERENCES payroll_runs(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  cutoff_date DATE,
  payment_date DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PROCESSING','REVIEW','PENDING_APPROVAL','APPROVED','LOCKED',
                      'PAYMENT','POSTED','COMPLETED','REVERSED','CANCELLED')),
  progress INT NOT NULL DEFAULT 0,
  total_employees INT NOT NULL DEFAULT 0,
  gross_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contributions_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  validation_score INT NOT NULL DEFAULT 0,
  prepared_by BIGINT REFERENCES users(id),
  locked_by BIGINT REFERENCES users(id),
  locked_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  journal_entry_id BIGINT,
  payment_batch_id BIGINT,
  notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, run_no)
);
CREATE INDEX idx_payroll_runs_company ON payroll_runs(company_id, period_start DESC);
CREATE INDEX idx_payroll_runs_period ON payroll_runs(period_id);
CREATE UNIQUE INDEX uq_payroll_runs_normal_period
  ON payroll_runs (company_id, payroll_group_id, period_id)
  WHERE run_type = 'NORMAL' AND status NOT IN ('CANCELLED','REVERSED');

-- ---------- Per-employee run rows (snapshot + allocation) ----------
CREATE TABLE payroll_run_employees (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  employee_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current BOOLEAN NOT NULL DEFAULT true,
  version_no INT NOT NULL DEFAULT 1,
  calculation_version INT NOT NULL DEFAULT 0,
  cost_centre_allocation JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CALCULATED','VALIDATED','ERROR','EXCLUDED')),
  basic_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  days_worked NUMERIC(8,2) NOT NULL DEFAULT 0,
  hours_worked NUMERIC(10,2) NOT NULL DEFAULT 0,
  unpaid_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  gross_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  employee_contributions NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contributions NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id, version_no)
);
CREATE INDEX idx_run_employees_run ON payroll_run_employees(payroll_run_id, is_current);
CREATE INDEX idx_run_employees_emp ON payroll_run_employees(employee_id);

-- ---------- Unified payroll calculation ledger (line items) ----------
CREATE TABLE payroll_calculations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  run_employee_id BIGINT NOT NULL REFERENCES payroll_run_employees(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('EARNING','DEDUCTION','STATUTORY','EMPLOYER_CONTRIBUTION')),
  component_id BIGINT REFERENCES salary_components(id),
  component_code TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(12,2),
  unit_amount NUMERIC(18,2),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT false,
  statutory BOOLEAN NOT NULL DEFAULT false,
  is_current BOOLEAN NOT NULL DEFAULT true,
  version_no INT NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'SYSTEM'
    CHECK (source IN ('SYSTEM','IMPORT','MANUAL','FORMULA','STATUTORY','LOAN','ADVANCE','OVERTIME','BONUS','COMMISSION','BENEFIT')),
  source_ref TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_calc_run ON payroll_calculations(payroll_run_id, run_employee_id, is_current);
CREATE INDEX idx_payroll_calc_emp ON payroll_calculations(employee_id);
CREATE INDEX idx_payroll_calc_component ON payroll_calculations(component_code, payroll_run_id);

-- Views over the unified ledger (spec tables payroll_earnings / payroll_deductions)
CREATE VIEW payroll_earnings AS
  SELECT id, company_id, tenant_id, payroll_run_id, run_employee_id, employee_id,
         component_id, component_code, description, quantity, unit_amount, amount,
         taxable, statutory, is_current, version_no, source, source_ref, details, created_at
  FROM payroll_calculations WHERE kind = 'EARNING';

CREATE VIEW payroll_deductions AS
  SELECT id, company_id, tenant_id, payroll_run_id, run_employee_id, employee_id,
         component_id, component_code, description, quantity, unit_amount, amount,
         taxable, statutory, is_current, version_no, source, source_ref, details, created_at
  FROM payroll_calculations WHERE kind IN ('DEDUCTION','STATUTORY');

-- ---------- Payroll exceptions / validation centre ----------
CREATE TABLE payroll_exceptions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id BIGINT REFERENCES employees(id),
  exception_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('WARNING','ERROR','HIGH_RISK')),
  message TEXT NOT NULL,
  reference_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_exceptions_run ON payroll_exceptions(payroll_run_id, status);

-- ---------- Payroll approvals (4-eyes / SOD evidence) ----------
CREATE TABLE payroll_approvals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  approver_user_id BIGINT NOT NULL REFERENCES users(id),
  role_code TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('SUBMIT','APPROVE','REJECT','RETURN','LOCK','UNLOCK','POST','RELEASE','REVERSE','CANCEL')),
  comment TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_payroll_approvals_run ON payroll_approvals(payroll_run_id);

-- ---------- Payroll locks ----------
CREATE TABLE payroll_locks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'LOCKED' CHECK (status IN ('LOCKED','UNLOCKED')),
  locked_by BIGINT NOT NULL REFERENCES users(id),
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  unlocked_by BIGINT REFERENCES users(id),
  unlocked_at TIMESTAMPTZ,
  unlock_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_locks_run ON payroll_locks(payroll_run_id, status);

-- ---------- Payroll adjustments ----------
CREATE TABLE payroll_adjustments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  adjustment_type TEXT NOT NULL
    CHECK (adjustment_type IN ('SALARY','ALLOWANCE','TAX','DEDUCTION','OVERTIME','BONUS','COMMISSION','BENEFIT','OTHER')),
  reason TEXT NOT NULL,
  original_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  new_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  difference NUMERIC(18,2) NOT NULL DEFAULT 0,
  effective_period_start DATE NOT NULL,
  effective_period_end DATE NOT NULL,
  applied_in_run_id BIGINT REFERENCES payroll_runs(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING','APPROVED','APPLIED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_adjustments_emp ON payroll_adjustments(employee_id, status);

-- ---------- Arrears ----------
CREATE TABLE payroll_arrears (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  adjustment_id BIGINT REFERENCES payroll_adjustments(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  original_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  correct_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  difference NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_impact NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_arrears NUMERIC(18,2) NOT NULL DEFAULT 0,
  from_period_start DATE NOT NULL,
  to_period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_arrears_emp ON payroll_arrears(employee_id);

-- ---------- Final settlements (terminated employees) ----------
CREATE TABLE final_settlements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  settlement_no TEXT NOT NULL,
  termination_date DATE NOT NULL,
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  salary_due NUMERIC(18,2) NOT NULL DEFAULT 0,
  leave_payment NUMERIC(18,2) NOT NULL DEFAULT 0,
  benefits_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  outstanding_loans NUMERIC(18,2) NOT NULL DEFAULT 0,
  outstanding_advances NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING','APPROVED','PAID','CLOSED')),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  prepared_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, settlement_no)
);
CREATE INDEX idx_final_settlements_emp ON final_settlements(employee_id);

-- ---------- Payroll status history ----------
CREATE TABLE payroll_status_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by BIGINT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  comment TEXT
);
CREATE INDEX idx_payroll_status_history_run ON payroll_status_history(payroll_run_id);

-- ---------- Payment batches ----------
CREATE TABLE payment_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  batch_no TEXT NOT NULL,
  batch_type TEXT NOT NULL DEFAULT 'PAYROLL'
    CHECK (batch_type IN ('PAYROLL','FINAL','ADJUSTMENT','REVERSAL')),
  currency TEXT NOT NULL DEFAULT 'UGX',
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  item_count INT NOT NULL DEFAULT 0,
  file_format TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','APPROVED','EXPORTED','CONFIRMED','FAILED','RECONCILED')),
  created_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, batch_no)
);
CREATE INDEX idx_payment_batches_run ON payment_batches(payroll_run_id);

CREATE TABLE payment_batch_items (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  batch_id BIGINT NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
  bank_name TEXT,
  masked_account_no TEXT,
  mobile_no TEXT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PAID','FAILED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_items_batch ON payment_batch_items(batch_id, status);

-- ---------- Payment transactions ----------
CREATE TABLE payment_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  batch_id BIGINT NOT NULL REFERENCES payment_batches(id),
  item_id BIGINT REFERENCES payment_batch_items(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  transaction_ref TEXT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  channel TEXT NOT NULL DEFAULT 'BANK',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SUCCESS','FAILED','REVERSED')),
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  processed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_tx_batch ON payment_transactions(batch_id);

-- ---------- Payment reconciliations ----------
CREATE TABLE payment_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  batch_id BIGINT REFERENCES payment_batches(id),
  journal_entry_id BIGINT,
  payroll_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  batch_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  bank_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  journal_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','MATCHED','DIFFERENCE')),
  differences JSONB NOT NULL DEFAULT '[]'::jsonb,
  reconciled_by BIGINT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, batch_id)
);

-- ---------- Payslips ----------
CREATE TABLE payslips (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id),
  run_employee_id BIGINT NOT NULL REFERENCES payroll_run_employees(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  payslip_no TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  gross_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contributions NUMERIC(18,2) NOT NULL DEFAULT 0,
  payment_date DATE,
  verification_code TEXT,
  published_at TIMESTAMPTZ,
  published_by BIGINT REFERENCES users(id),
  viewed_at TIMESTAMPTZ,
  viewed_count INT NOT NULL DEFAULT 0,
  download_count INT NOT NULL DEFAULT 0,
  watermark TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, run_employee_id),
  UNIQUE (company_id, payslip_no)
);
CREATE INDEX idx_payslips_emp ON payslips(employee_id, status);

-- ---------- Payroll documents ----------
CREATE TABLE payroll_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  employee_id BIGINT REFERENCES employees(id),
  doc_type TEXT NOT NULL,
  doc_no TEXT,
  file_url TEXT,
  storage_key TEXT,
  checksum TEXT,
  uploaded_by BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_documents_run ON payroll_documents(payroll_run_id);

-- ---------- Fraud / risk alerts ----------
CREATE TABLE fraud_alerts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  employee_id BIGINT REFERENCES employees(id),
  payroll_run_id BIGINT REFERENCES payroll_runs(id),
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','REVIEWED','RESOLVED','FALSE_POSITIVE')),
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fraud_alerts_status ON fraud_alerts(company_id, status);

-- ---------- Payroll audit trail (immutable; no update trigger) ----------
CREATE TABLE payroll_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_run_id BIGINT,
  employee_id BIGINT,
  user_id BIGINT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  reason TEXT,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_audit_company ON payroll_audit_logs(company_id, created_at DESC);
CREATE INDEX idx_payroll_audit_run ON payroll_audit_logs(payroll_run_id);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('payroll_groups','payroll_calendars','payroll_periods',
        'salary_components','salary_structures','payroll_settings','payroll_gl_mappings',
        'employee_payroll_profiles','employee_earnings','employee_deductions','employee_benefits',
        'overtime_records','bonus_records','commission_records','employee_loans','salary_advances',
        'statutory_rules','statutory_rule_versions','employee_tax_profiles','statutory_submissions',
        'payroll_runs','payroll_run_employees','payroll_adjustments','payroll_arrears',
        'final_settlements','payment_batches','payment_reconciliations','payslips','fraud_alerts')
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

-- ---------- Immutability guards (closed payroll is frozen) ----------
CREATE OR REPLACE FUNCTION payroll_runs_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('LOCKED','POSTED','COMPLETED','REVERSED') THEN
    IF NEW.status <> OLD.status AND NEW.status <> 'REVERSED' THEN
      RAISE EXCEPTION 'Payroll run % is %; only a reversal is permitted from this state', OLD.run_no, OLD.status;
    END IF;
    IF (NEW.gross_total <> OLD.gross_total OR NEW.net_total <> OLD.net_total
        OR NEW.deduction_total <> OLD.deduction_total OR NEW.tax_total <> OLD.tax_total
        OR NEW.employer_contributions_total <> OLD.employer_contributions_total
        OR NEW.taxable_total <> OLD.taxable_total) THEN
      RAISE EXCEPTION 'Payroll run % is %; financial totals are immutable', OLD.run_no, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payroll_runs_immutable
  BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_runs_immutable();

CREATE OR REPLACE FUNCTION payroll_calc_immutable() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT status INTO run_status FROM payroll_runs WHERE id = COALESCE(NEW.payroll_run_id, OLD.payroll_run_id);
  IF run_status IN ('LOCKED','POSTED','COMPLETED','REVERSED') THEN
    RAISE EXCEPTION 'Payroll run is %; calculation line items are immutable. Use an adjustment or off-cycle run.', run_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payroll_calc_immutable
  BEFORE UPDATE OR DELETE ON payroll_calculations
  FOR EACH ROW EXECUTE FUNCTION payroll_calc_immutable();

CREATE TRIGGER trg_run_employee_immutable
  BEFORE UPDATE OR DELETE ON payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION payroll_calc_immutable();

-- ---------- Row-level security (tenant isolation at the database) ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('payroll_groups','payroll_calendars','payroll_periods',
        'salary_components','salary_structures','salary_structure_lines','payroll_settings',
        'payroll_gl_mappings','employee_payroll_profiles','employee_salaries',
        'employee_earnings','employee_deductions','employee_benefits','overtime_records',
        'bonus_records','commission_records','employee_loans','loan_repayments',
        'salary_advances','advance_repayments','statutory_rules','statutory_rule_versions',
        'tax_brackets','employee_tax_profiles','statutory_calculations','statutory_submissions',
        'payroll_runs','payroll_run_employees','payroll_calculations','payroll_exceptions',
        'payroll_approvals','payroll_locks','payroll_adjustments','payroll_arrears',
        'final_settlements','payroll_status_history','payment_batches','payment_batch_items',
        'payment_transactions','payment_reconciliations','payslips','payroll_documents',
        'fraud_alerts','payroll_audit_logs')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

-- ---------- DB-level audit triggers on payroll tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_groups','payroll_calendars','payroll_periods','salary_components',
    'salary_structures','salary_structure_lines','payroll_settings','payroll_gl_mappings',
    'employee_payroll_profiles','employee_salaries','employee_earnings','employee_deductions',
    'employee_benefits','overtime_records','bonus_records','commission_records','employee_loans',
    'loan_repayments','salary_advances','advance_repayments','statutory_rules',
    'statutory_rule_versions','tax_brackets','employee_tax_profiles','statutory_calculations',
    'statutory_submissions','payroll_runs','payroll_run_employees','payroll_calculations',
    'payroll_exceptions','payroll_approvals','payroll_locks','payroll_adjustments',
    'payroll_arrears','final_settlements','payroll_status_history','payment_batches',
    'payment_batch_items','payment_transactions','payment_reconciliations','payslips',
    'payroll_documents','fraud_alerts'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
