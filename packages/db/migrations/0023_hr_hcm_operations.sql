-- ============================================================
-- 0023 HCM - Operations: Attendance, Leave Engine, Performance,
-- Learning & Development, Benefits, Employee Relations, Assets,
-- Payroll Configuration (incl. versioned statutory configs), Self-Service
-- ============================================================

-- ---------- Attendance & Time ----------
CREATE TABLE shifts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  work_hours NUMERIC(5,2) NOT NULL DEFAULT 8,
  applies_to TEXT NOT NULL DEFAULT 'ALL'
    CHECK (applies_to IN ('ALL','FULL_TIME','PART_TIME','CONTRACT')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shift_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  shift_id BIGINT NOT NULL REFERENCES shifts(id),
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_shift_assignments_employee ON shift_assignments(employee_id);

CREATE TABLE overtime_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  work_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  hours NUMERIC(6,2) NOT NULL,
  reason TEXT,
  rate_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.5,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_overtime_requests_employee ON overtime_requests(employee_id);

CREATE TABLE timesheets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_timesheets_employee ON timesheets(employee_id);

CREATE TABLE projects (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE,
  end_date DATE,
  budget NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  manager_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE timesheet_lines (
  id BIGSERIAL PRIMARY KEY,
  timesheet_id BIGINT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  hours NUMERIC(6,2) NOT NULL,
  project_id BIGINT REFERENCES projects(id),
  task TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_timesheet_lines_timesheet ON timesheet_lines(timesheet_id);

ALTER TABLE attendance
  ADD COLUMN shift_id BIGINT REFERENCES shifts(id),
  ADD COLUMN overtime_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN late_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN early_leave_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN source TEXT,
  ADD COLUMN ip_address TEXT,
  ADD COLUMN attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX idx_attendance_shift ON attendance(shift_id);

-- ---------- Leave engine ----------
CREATE TABLE leave_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('ANNUAL','SICK','MATERNITY','PATERNITY','UNPAID','STUDY',
                        'COMPASSIONATE','BEREAVEMENT','PUBLIC','OTHER')),
  days_per_year NUMERIC(6,2),
  max_consecutive_days NUMERIC(6,2),
  carryover_limit NUMERIC(6,2) NOT NULL DEFAULT 0,
  is_paid BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leave_policies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  leave_type_id BIGINT REFERENCES leave_types(id),
  applies_to TEXT NOT NULL DEFAULT 'ALL'
    CHECK (applies_to IN ('ALL','FULL_TIME','PART_TIME','PROBATION','CONTRACT')),
  accrual_method TEXT NOT NULL DEFAULT 'MONTHLY_PROPORTION'
    CHECK (accrual_method IN ('MONTHLY_PROPORTION','YEARLY_LUMP','PER_DAY_WORKED','NONE')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leave_accrual_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL DEFAULT 'MONTHLY_PROPORTION'
    CHECK (rule_type IN ('MONTHLY_PROPORTION','YEARLY_LUMP','PER_DAY_WORKED')),
  accrual_rate NUMERIC(10,4) NOT NULL,
  cap NUMERIC(6,2),
  minimum_service_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leave_balances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  leave_type_id BIGINT NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  opening_balance NUMERIC(6,2) NOT NULL DEFAULT 0,
  accrued NUMERIC(6,2) NOT NULL DEFAULT 0,
  used NUMERIC(6,2) NOT NULL DEFAULT 0,
  adjusted NUMERIC(6,2) NOT NULL DEFAULT 0,
  available NUMERIC(6,2) NOT NULL DEFAULT 0,
  UNIQUE (employee_id, leave_type_id, year),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leave_balances_employee ON leave_balances(employee_id);

CREATE TABLE holidays (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  holiday_date DATE NOT NULL,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  country TEXT NOT NULL DEFAULT 'UG',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leave_requests
  ADD COLUMN leave_type_id BIGINT REFERENCES leave_types(id),
  ADD COLUMN balance_id BIGINT REFERENCES leave_balances(id),
  ADD COLUMN policy_id BIGINT REFERENCES leave_policies(id),
  ADD COLUMN review_notes TEXT;
CREATE INDEX idx_leave_requests_type ON leave_requests(leave_type_id);

-- ---------- Performance ----------
CREATE TABLE performance_goals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  start_date DATE,
  due_date DATE,
  weight NUMERIC(5,2) NOT NULL DEFAULT 0,
  progress NUMERIC(5,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','IN_PROGRESS','ACHIEVED','ON_TRACK','AT_RISK','PAST_DUE','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_performance_goals_employee ON performance_goals(employee_id);

CREATE TABLE performance_kpis (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  goal_id BIGINT REFERENCES performance_goals(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  unit TEXT,
  target_value NUMERIC(14,2),
  actual_value NUMERIC(14,2),
  weight NUMERIC(5,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ACHIEVED','MISSED','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_performance_kpis_employee ON performance_kpis(employee_id);

CREATE TABLE performance_reviews (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  review_type TEXT NOT NULL DEFAULT 'ANNUAL'
    CHECK (review_type IN ('ANNUAL','HALF_YEAR','QUARTERLY','PROBATION','PROMOTION','EXIT')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','SUBMITTED','APPROVED','COMPLETED','CANCELLED')),
  overall_rating NUMERIC(3,2),
  summary TEXT,
  reviewer_id BIGINT,
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_performance_reviews_employee ON performance_reviews(employee_id);

CREATE TABLE performance_review_items (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  criteria TEXT NOT NULL,
  rating NUMERIC(3,2),
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_items_review ON performance_review_items(review_id);

CREATE TABLE performance_review_feedback (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  reviewer_id BIGINT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'MANAGER'
    CHECK (relation IN ('SELF','MANAGER','PEER','SUBORDINATE','EXTERNAL')),
  rating NUMERIC(3,2),
  comments TEXT,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_feedback_review ON performance_review_feedback(review_id);

CREATE TABLE performance_improvement_plans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  reason TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  progress NUMERIC(5,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','IMPROVED','CLOSED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pip_employee ON performance_improvement_plans(employee_id);

-- ---------- Learning & Development ----------
CREATE TABLE training_catalog (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  description TEXT,
  duration_hours NUMERIC(6,2),
  provider TEXT,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  certification_renewal_months INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE training_sessions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  training_id BIGINT NOT NULL REFERENCES training_catalog(id),
  code TEXT NOT NULL,
  trainer TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  location TEXT,
  capacity INTEGER,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE training_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  training_id BIGINT REFERENCES training_catalog(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_training_requests_employee ON training_requests(employee_id);

CREATE TABLE training_enrollments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  session_id BIGINT NOT NULL REFERENCES training_sessions(id),
  status TEXT NOT NULL DEFAULT 'ENROLLED'
    CHECK (status IN ('ENROLLED','ATTENDED','COMPLETED','NO_SHOW','CANCELLED')),
  score NUMERIC(6,2),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_training_enrollments_employee ON training_enrollments(employee_id);

CREATE TABLE competencies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  proficiency_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_competencies (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  competency_id BIGINT NOT NULL REFERENCES competencies(id),
  level NUMERIC(5,2),
  target_level NUMERIC(5,2),
  assessed_by BIGINT,
  assessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_competencies_employee ON employee_competencies(employee_id);

CREATE TABLE training_certificates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  training_id BIGINT REFERENCES training_catalog(id),
  certificate_no TEXT,
  issued_at DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID','EXPIRING','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_training_certificates_employee ON training_certificates(employee_id);

-- ---------- Benefits ----------
CREATE TABLE benefit_plans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('MEDICAL','INSURANCE','ALLOWANCE','TRANSPORT','MEAL','HOUSING','OTHER')),
  provider TEXT,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  employee_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  employer_contribution NUMERIC(18,2) NOT NULL DEFAULT 0,
  eligibility_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE benefit_enrollments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  plan_id BIGINT NOT NULL REFERENCES benefit_plans(id),
  dependant_id BIGINT REFERENCES employee_dependants(id),
  effective_from DATE NOT NULL,
  effective_to DATE,
  monthly_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','PENDING','SUSPENDED','CANCELLED','EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_benefit_enrollments_employee ON benefit_enrollments(employee_id);

CREATE TABLE benefit_claims (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  enrollment_id BIGINT REFERENCES benefit_enrollments(id),
  claim_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  category TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','PAID','CANCELLED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_benefit_claims_employee ON benefit_claims(employee_id);

-- ---------- Employee relations ----------
CREATE TABLE grievances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('HARASSMENT','DISCRIMINATION','WORKPLACE','PAY','MANAGEMENT','OTHER')),
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','UNDER_REVIEW','INVESTIGATING','RESOLVED','CLOSED')),
  resolution TEXT,
  resolved_by BIGINT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_grievances_employee ON grievances(employee_id);

CREATE TABLE investigations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  case_type TEXT NOT NULL DEFAULT 'DISCIPLINARY'
    CHECK (case_type IN ('GRIEVANCE','DISCIPLINARY')),
  grievance_id BIGINT REFERENCES grievances(id),
  investigator_user_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  findings TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disciplinary_cases (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  case_no TEXT NOT NULL,
  incident_date DATE,
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('MISCONDUCT','ABSENTEEISM','THEFT','VIOLENCE','INSOLENCE',
                        'NEGLIGENCE','FRAUD','OTHER')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REPORTED'
    CHECK (status IN ('REPORTED','INVESTIGATING','NOTICE_ISSUED','HEARING',
                      'DECISION_MADE','APPEAL','CLOSED')),
  decision TEXT,
  decision_date DATE,
  UNIQUE (company_id, case_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_disciplinary_cases_employee ON disciplinary_cases(employee_id);

ALTER TABLE investigations
  ADD COLUMN disciplinary_case_id BIGINT REFERENCES disciplinary_cases(id);

CREATE TABLE disciplinary_actions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  case_id BIGINT REFERENCES disciplinary_cases(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL DEFAULT 'WRITTEN_WARNING'
    CHECK (action_type IN ('VERBAL_WARNING','WRITTEN_WARNING','FINAL_WARNING',
                           'SUSPENSION','DEMOTION','TERMINATION')),
  description TEXT,
  effective_date DATE NOT NULL,
  duration_days INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','COMPLETED','EXPIRED','OVERTURNED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_disciplinary_actions_employee ON disciplinary_actions(employee_id);

CREATE TABLE warnings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  warning_type TEXT NOT NULL DEFAULT 'VERBAL'
    CHECK (warning_type IN ('VERBAL','WRITTEN','FINAL')),
  reason TEXT NOT NULL,
  issued_by BIGINT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_warnings_employee ON warnings(employee_id);

-- ---------- Asset assignments ----------
CREATE TABLE asset_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  assigned_by BIGINT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_return_date DATE,
  returned_at TIMESTAMPTZ,
  condition_on_return TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED','RETURNED','LOST','DAMAGED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_assignments_employee ON asset_assignments(employee_id);
CREATE INDEX idx_asset_assignments_asset ON asset_assignments(asset_id);

-- ---------- Payroll configuration ----------
CREATE TABLE payroll_component_definitions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'EARNING'
    CHECK (type IN ('EARNING','DEDUCTION')),
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('ALLOWANCE','BONUS','OVERTIME','REIMBURSEMENT','LOAN',
                        'ADVANCE','TAX','STATUTORY','OTHER')),
  is_taxable BOOLEAN NOT NULL DEFAULT true,
  is_benefit_in_kind BOOLEAN NOT NULL DEFAULT false,
  calculation_type TEXT NOT NULL DEFAULT 'FIXED'
    CHECK (calculation_type IN ('FIXED','PERCENTAGE','FORMULA')),
  value NUMERIC(18,4),
  formula JSONB,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_payroll_components (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  component_id BIGINT NOT NULL REFERENCES payroll_component_definitions(id),
  value NUMERIC(18,4) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_payroll_components_employee ON employee_payroll_components(employee_id);

CREATE TABLE payroll_component_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payroll_id BIGINT NOT NULL REFERENCES payrolls(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  component_id BIGINT NOT NULL REFERENCES payroll_component_definitions(id),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  quantity NUMERIC(10,2),
  rate NUMERIC(18,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_component_entries_payroll ON payroll_component_entries(payroll_id);

-- Versioned, configurable statutory/regulatory values (never hard-code in code).
CREATE TABLE statutory_configs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  country TEXT NOT NULL DEFAULT 'UG',
  category TEXT NOT NULL
    CHECK (category IN ('PAYE','NSSF','LST','SDI','WHT','SEVERANCE','MINIMUM_WAGE','OTHER')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  rates JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  formula JSONB,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_statutory_configs_country_category ON statutory_configs(country, category);

ALTER TABLE payrolls
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN statutory_config_id BIGINT REFERENCES statutory_configs(id),
  ADD COLUMN statutory_snapshot JSONB;

ALTER TABLE payroll_items
  ADD COLUMN taxable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN employer_nssf NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN lst NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN breakdown JSONB;

-- ---------- Employee self-service ----------
CREATE TABLE employee_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  request_type TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (request_type IN ('PROFILE_UPDATE','DOCUMENT','PAYSLIP','CERTIFICATE',
                            'TRANSFER','PROMOTION','ADVANCE','OTHER')),
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  response TEXT,
  handled_by BIGINT,
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_requests_employee ON employee_requests(employee_id);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('projects','shifts','shift_assignments','overtime_requests','timesheets',
        'timesheet_lines','leave_types','leave_policies','leave_accrual_rules',
        'leave_balances','holidays','performance_goals','performance_kpis',
        'performance_reviews','performance_review_items','performance_review_feedback',
        'performance_improvement_plans','training_catalog','training_sessions',
        'training_requests','training_enrollments','competencies','employee_competencies',
        'training_certificates','benefit_plans','benefit_enrollments','benefit_claims',
        'grievances','investigations','disciplinary_cases','disciplinary_actions',
        'warnings','asset_assignments','payroll_component_definitions',
        'employee_payroll_components','statutory_configs','employee_requests')
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
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_accrual_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_review_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_improvement_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE grievances ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE disciplinary_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE disciplinary_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_component_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_payroll_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_component_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON shifts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON shift_assignments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON overtime_requests USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON timesheets USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON timesheet_lines USING (timesheet_id IN (SELECT id FROM timesheets));
CREATE POLICY tenant_isolation ON leave_types USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON leave_policies USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON leave_accrual_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON leave_balances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON holidays USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON performance_goals USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON performance_kpis USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON performance_reviews USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON performance_review_items USING (review_id IN (SELECT id FROM performance_reviews));
CREATE POLICY tenant_isolation ON performance_review_feedback USING (review_id IN (SELECT id FROM performance_reviews));
CREATE POLICY tenant_isolation ON performance_improvement_plans USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON training_catalog USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON training_sessions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON training_requests USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON training_enrollments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON competencies USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON employee_competencies USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON training_certificates USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON benefit_plans USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON benefit_enrollments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON benefit_claims USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON grievances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON investigations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON disciplinary_cases USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON disciplinary_actions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON warnings USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON asset_assignments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON payroll_component_definitions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON employee_payroll_components USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON payroll_component_entries USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON statutory_configs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON employee_requests USING (tenant_id = app_tenant_id());

-- ---------- DB-level audit triggers on HCM operations tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects','shifts','shift_assignments','overtime_requests','timesheets','timesheet_lines',
    'leave_types','leave_policies','leave_accrual_rules','leave_balances','holidays',
    'performance_goals','performance_kpis','performance_reviews','performance_review_items',
    'performance_review_feedback','performance_improvement_plans','training_catalog',
    'training_sessions','training_requests','training_enrollments','competencies',
    'employee_competencies','training_certificates','benefit_plans','benefit_enrollments',
    'benefit_claims','grievances','investigations','disciplinary_cases',
    'disciplinary_actions','warnings','asset_assignments','payroll_component_definitions',
    'employee_payroll_components','payroll_component_entries','statutory_configs',
    'employee_requests'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
