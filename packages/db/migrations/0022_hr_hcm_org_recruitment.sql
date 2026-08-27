-- ============================================================
-- 0022 HCM - Organization, Workforce Planning, Recruitment/ATS, Onboarding
-- Enterprise Human Capital Management (tenant + company + branch scoped)
-- ============================================================

-- ---------- Organization management ----------
CREATE TABLE divisions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  head_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'WORKPLACE'
    CHECK (type IN ('WORKPLACE','FACTORY','WAREHOUSE','SITE','FIELD','REMOTE','RETAIL')),
  address TEXT,
  city TEXT,
  country TEXT NOT NULL DEFAULT 'UG',
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  geo JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_units (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  parent_id BIGINT REFERENCES org_units(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  head_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  org_unit_id BIGINT REFERENCES org_units(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  lead_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_families (
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

CREATE TABLE job_grades (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  min_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A position is an approved slot; it is separate from the employee who occupies it.
CREATE TABLE positions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  division_id BIGINT REFERENCES divisions(id),
  org_unit_id BIGINT REFERENCES org_units(id),
  team_id BIGINT REFERENCES teams(id),
  location_id BIGINT REFERENCES locations(id),
  job_family_id BIGINT REFERENCES job_families(id),
  job_grade_id BIGINT REFERENCES job_grades(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  report_to_position_id BIGINT REFERENCES positions(id),
  approved_headcount INTEGER NOT NULL DEFAULT 1,
  salary_min NUMERIC(18,2) NOT NULL DEFAULT 0,
  salary_max NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  required_qualifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  job_description TEXT,
  status TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (status IN ('PLANNED','APPROVED','FROZEN','CLOSED')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_positions_department ON positions(department_id);
CREATE INDEX idx_positions_grade ON positions(job_grade_id);
CREATE INDEX idx_positions_report_to ON positions(report_to_position_id);

-- Position assignment history: hire, promotion, transfer, temporary cover.
CREATE TABLE position_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  position_id BIGINT NOT NULL REFERENCES positions(id),
  effective_from DATE NOT NULL,
  effective_to DATE,
  assignment_type TEXT NOT NULL DEFAULT 'HIRE'
    CHECK (assignment_type IN ('HIRE','PROMOTION','TRANSFER','TEMPORARY','SECONDMENT')),
  is_primary BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_assign_employee ON position_assignments(employee_id);
CREATE INDEX idx_pos_assign_position ON position_assignments(position_id);

-- ---------- Workforce planning ----------
CREATE TABLE workforce_plans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  plan_no TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  budget_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','EXECUTING','CLOSED')),
  submitted_by BIGINT,
  submitted_at TIMESTAMPTZ,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, plan_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workforce_plan_lines (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES workforce_plans(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL,
  tenant_id BIGINT NOT NULL,
  position_id BIGINT REFERENCES positions(id),
  current_headcount INTEGER NOT NULL DEFAULT 0,
  planned_headcount INTEGER NOT NULL DEFAULT 0,
  expected_departures INTEGER NOT NULL DEFAULT 0,
  retirements INTEGER NOT NULL DEFAULT 0,
  new_positions INTEGER NOT NULL DEFAULT 0,
  hiring_requirement INTEGER NOT NULL DEFAULT 0,
  salary_budget NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wfp_lines_plan ON workforce_plan_lines(plan_id);

-- Scenario planning: "what if production grows 30%?" - parameters + computed results.
CREATE TABLE workforce_scenarios (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  plan_id BIGINT REFERENCES workforce_plans(id),
  scenario_no TEXT NOT NULL,
  name TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SAVED','ACTIVE')),
  created_by BIGINT,
  UNIQUE (company_id, scenario_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Recruitment / ATS ----------
CREATE TABLE job_requisitions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  position_id BIGINT REFERENCES positions(id),
  requisition_no TEXT NOT NULL,
  title TEXT NOT NULL,
  job_family_id BIGINT REFERENCES job_families(id),
  job_grade_id BIGINT REFERENCES job_grades(id),
  employment_type TEXT NOT NULL DEFAULT 'PERMANENT'
    CHECK (employment_type IN ('PERMANENT','CONTRACT','PART_TIME','CASUAL','INTERNSHIP')),
  headcount INTEGER NOT NULL DEFAULT 1,
  salary_min NUMERIC(18,2) NOT NULL DEFAULT 0,
  salary_max NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  justification TEXT,
  budget_code TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','FILLED','CANCELLED')),
  submitted_by BIGINT,
  submitted_at TIMESTAMPTZ,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, requisition_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_requisitions_status ON job_requisitions(tenant_id, status);

CREATE TABLE vacancies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  requisition_id BIGINT REFERENCES job_requisitions(id),
  position_id BIGINT REFERENCES positions(id),
  location_id BIGINT REFERENCES locations(id),
  vacancy_no TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  openings INTEGER NOT NULL DEFAULT 1,
  filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ON_HOLD','CLOSED','CANCELLED')),
  published_at TIMESTAMPTZ,
  closes_at DATE,
  external_url TEXT,
  UNIQUE (company_id, vacancy_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vacancies_status ON vacancies(tenant_id, status);

CREATE TABLE candidates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','JOB_PORTAL','REFERRAL','LINKEDIN','AGENCY','WALK_IN','CAREER_SITE')),
  current_employer TEXT,
  current_title TEXT,
  rating NUMERIC(3,1),
  resume_document_id BIGINT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLACKLISTED','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_candidates_email ON candidates(tenant_id, lower(email));

CREATE TABLE candidate_applications (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  candidate_id BIGINT NOT NULL REFERENCES candidates(id),
  vacancy_id BIGINT NOT NULL REFERENCES vacancies(id),
  application_no TEXT NOT NULL,
  cover_letter TEXT,
  expected_salary NUMERIC(18,2),
  currency TEXT NOT NULL DEFAULT 'UGX',
  notice_period_days INTEGER,
  stage_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','SCREENING','SHORTLISTED','INTERVIEW','ASSESSMENT',
                      'REFERENCE_CHECK','OFFER','ACCEPTED','REJECTED','WITHDRAWN')),
  current_rating NUMERIC(3,1),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, application_no),
  UNIQUE (candidate_id, vacancy_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_applications_status ON candidate_applications(tenant_id, status);
CREATE INDEX idx_applications_vacancy ON candidate_applications(vacancy_id);

CREATE TABLE interviews (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  application_id BIGINT NOT NULL REFERENCES candidate_applications(id),
  interview_no TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL DEFAULT 'IN_PERSON' CHECK (mode IN ('IN_PERSON','PHONE','VIDEO')),
  interviewer_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_minutes INTEGER NOT NULL DEFAULT 45,
  location TEXT,
  outcome TEXT,
  rating NUMERIC(3,1),
  feedback JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED','NO_SHOW')),
  UNIQUE (company_id, interview_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_interviews_application ON interviews(application_id);

CREATE TABLE assessments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  application_id BIGINT NOT NULL REFERENCES candidate_applications(id),
  assessment_no TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'TECHNICAL'
    CHECK (type IN ('TECHNICAL','PSYCHOMETRIC','SKILLS','LANGUAGE','BACKGROUND','MEDICAL')),
  score NUMERIC(6,2),
  max_score NUMERIC(6,2),
  result TEXT NOT NULL DEFAULT 'PENDING' CHECK (result IN ('PENDING','PASS','FAIL')),
  assessed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (company_id, assessment_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_offers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  application_id BIGINT REFERENCES candidate_applications(id),
  candidate_id BIGINT NOT NULL REFERENCES candidates(id),
  position_id BIGINT REFERENCES positions(id),
  offer_no TEXT NOT NULL,
  base_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  allowances JSONB NOT NULL DEFAULT '{}'::jsonb,
  benefits JSONB NOT NULL DEFAULT '{}'::jsonb,
  currency TEXT NOT NULL DEFAULT 'UGX',
  contract_type TEXT NOT NULL DEFAULT 'PERMANENT',
  start_date DATE,
  probation_months INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SENT','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN')),
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, offer_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_offers_candidate ON job_offers(candidate_id);

-- ---------- Onboarding ----------
CREATE TABLE onboarding_checklists (
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

CREATE TABLE onboarding_tasks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  checklist_id BIGINT NOT NULL REFERENCES onboarding_checklists(id) ON DELETE CASCADE,
  task_no TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'DOCUMENT'
    CHECK (category IN ('DOCUMENT','EQUIPMENT','ACCOUNT','TRAINING','ORIENTATION','LEGAL','IT')),
  description TEXT,
  due_days INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (checklist_id, task_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_instances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  offer_id BIGINT REFERENCES job_offers(id),
  checklist_id BIGINT NOT NULL REFERENCES onboarding_checklists(id),
  instance_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, instance_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_onboarding_employee ON onboarding_instances(employee_id);

CREATE TABLE onboarding_instance_tasks (
  id BIGSERIAL PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES onboarding_instances(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES onboarding_tasks(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')),
  completed_by BIGINT,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (instance_id, task_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Employee record extensions ----------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id BIGINT REFERENCES positions(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS division_id BIGINT REFERENCES divisions(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS org_unit_id BIGINT REFERENCES org_units(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES teams(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES locations(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_family_id BIGINT REFERENCES job_families(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_grade_id BIGINT REFERENCES job_grades(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS cost_centre_id BIGINT REFERENCES cost_centres(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status TEXT
  CHECK (marital_status IN ('SINGLE','MARRIED','DIVORCED','WIDOWED','OTHER'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_no TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS next_of_kin JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS probation_end_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'PERMANENT'
  CHECK (employment_type IN ('PERMANENT','CONTRACT','PART_TIME','CASUAL','INTERNSHIP','PROBATION'));

CREATE TABLE employee_dependants (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'CHILD'
    CHECK (relationship IN ('SPOUSE','CHILD','PARENT','SIBLING','OTHER')),
  dob DATE,
  gender TEXT,
  national_id TEXT,
  is_beneficiary BOOLEAN NOT NULL DEFAULT false,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dependants_employee ON employee_dependants(employee_id);

CREATE TABLE employee_emergency_contacts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_emergency_employee ON employee_emergency_contacts(employee_id);

CREATE TABLE employee_skills (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'INTERMEDIATE'
    CHECK (proficiency IN ('BASIC','INTERMEDIATE','ADVANCED','EXPERT')),
  years_experience NUMERIC(5,2),
  last_used_year INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skills_employee ON employee_skills(employee_id);

CREATE TABLE employee_qualifications (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  qualification_type TEXT NOT NULL DEFAULT 'DEGREE'
    CHECK (qualification_type IN ('DEGREE','DIPLOMA','CERTIFICATE','MASTERS','PHD','PROFESSIONAL','OTHER')),
  institution TEXT NOT NULL,
  qualification_name TEXT NOT NULL,
  field_of_study TEXT,
  grade TEXT,
  start_date DATE,
  end_date DATE,
  country TEXT NOT NULL DEFAULT 'UG',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qualifications_employee ON employee_qualifications(employee_id);

CREATE TABLE employee_certifications (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  issuer TEXT,
  cert_no TEXT,
  issue_date DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_certs_employee ON employee_certifications(employee_id);

CREATE TABLE employee_work_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employer TEXT NOT NULL,
  job_title TEXT,
  start_date DATE,
  end_date DATE,
  salary NUMERIC(18,2),
  currency TEXT NOT NULL DEFAULT 'UGX',
  reason_for_leaving TEXT,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_work_history_employee ON employee_work_history(employee_id);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('divisions','locations','org_units','teams','job_families','job_grades',
        'positions','position_assignments','workforce_plans','workforce_plan_lines',
        'workforce_scenarios','job_requisitions','vacancies','candidates','candidate_applications',
        'interviews','assessments','job_offers','onboarding_checklists','onboarding_tasks',
        'onboarding_instances','onboarding_instance_tasks','employee_dependants',
        'employee_emergency_contacts','employee_skills','employee_qualifications',
        'employee_certifications','employee_work_history')
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
ALTER TABLE divisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_plan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_instance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_dependants ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON divisions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON locations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON org_units USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON teams USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON job_families USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON job_grades USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON positions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON position_assignments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON workforce_plans USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON workforce_plan_lines USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON workforce_scenarios USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON job_requisitions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON vacancies USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON candidates USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON candidate_applications USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON interviews USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON assessments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON job_offers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON onboarding_checklists USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON onboarding_tasks USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON onboarding_instances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON onboarding_instance_tasks USING (instance_id IN (SELECT id FROM onboarding_instances));
CREATE POLICY tenant_isolation ON employee_dependants USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON employee_emergency_contacts USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON employee_skills USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON employee_qualifications USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON employee_certifications USING (employee_id IN (SELECT id FROM employees));
CREATE POLICY tenant_isolation ON employee_work_history USING (employee_id IN (SELECT id FROM employees));

-- ---------- DB-level audit triggers on HCM tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'divisions','locations','org_units','teams','job_families','job_grades','positions',
    'position_assignments','workforce_plans','workforce_plan_lines','workforce_scenarios',
    'job_requisitions','vacancies','candidates','candidate_applications','interviews',
    'assessments','job_offers','onboarding_checklists','onboarding_tasks','onboarding_instances',
    'onboarding_instance_tasks','employee_dependants','employee_emergency_contacts',
    'employee_skills','employee_qualifications','employee_certifications','employee_work_history'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
