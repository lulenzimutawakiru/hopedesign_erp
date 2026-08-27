-- ============================================================
-- 0064 HR Contract Builder (Uganda Employment Act, 2006; Ch.226)
-- ============================================================
-- Legal baseline is configured (legal_rules / employment_types), never
-- hard-coded in application code. Executed contracts are immutable:
-- variations/renewals create NEW contract rows linked via previous_contract_id.

-- ---------- contract number counters ----------
CREATE TABLE contract_number_counters (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  prefix TEXT NOT NULL,
  doc_year INTEGER NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  UNIQUE (company_id, prefix, doc_year)
);
CREATE OR REPLACE FUNCTION contract_prefix_for_type(p_type text) RETURNS text AS $$
BEGIN
  RETURN CASE upper(p_type)
    WHEN 'PERMANENT' THEN 'EMP'
    WHEN 'FIXED_TERM' THEN 'FT'
    WHEN 'PROBATIONARY' THEN 'PROB'
    WHEN 'PART_TIME' THEN 'PT'
    WHEN 'TEMPORARY' THEN 'TEMP'
    WHEN 'APPRENTICESHIP' THEN 'APP'
    WHEN 'CASUAL' THEN 'CAS'
    WHEN 'INTERNSHIP' THEN 'INT'
    WHEN 'CONSULTANCY' THEN 'CONS'
    WHEN 'SECONDMENT' THEN 'SEC'
    WHEN 'RENEWAL' THEN 'RNW'
    WHEN 'VARIATION' THEN 'VAR'
    WHEN 'PROMOTION' THEN 'PROM'
    WHEN 'TRANSFER' THEN 'TRF'
    WHEN 'SALARY_ADJUSTMENT' THEN 'SAL'
    ELSE 'CTR'
  END;
END;
$$ LANGUAGE plpgsql STABLE;
CREATE OR REPLACE FUNCTION next_contract_no(
  p_tenant bigint, p_company bigint, p_type text, p_as_of date DEFAULT CURRENT_DATE
) RETURNS text AS $$
DECLARE
  v_prefix text;
  v_override text;
  v_year integer := EXTRACT(YEAR FROM p_as_of)::int;
  v_seq bigint;
BEGIN
  v_prefix := contract_prefix_for_type(p_type);
  SELECT COALESCE(NULLIF(value->>'prefix',''), NULLIF(value->>'value',''), value #>> '{}')
    INTO v_override
  FROM app_settings
  WHERE tenant_id = p_tenant AND company_id = p_company
    AND category = 'hr.contracts' AND key = 'contract_prefix.' || upper(p_type)
  LIMIT 1;
  IF v_override IS NOT NULL AND btrim(v_override) <> '' THEN
    v_prefix := btrim(v_override);
  END IF;
  INSERT INTO contract_number_counters (company_id, tenant_id, prefix, doc_year)
  VALUES (p_company, p_tenant, v_prefix, v_year)
  ON CONFLICT (company_id, prefix, doc_year) DO UPDATE SET last_seq = contract_number_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN v_prefix || '/' || v_year || '/' || lpad(v_seq::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------- expand employment_contracts ----------
ALTER TABLE employment_contracts
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS contract_no TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legal_framework_version TEXT,
  ADD COLUMN IF NOT EXISTS legal_rules_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS template_id BIGINT,
  ADD COLUMN IF NOT EXISTS template_version_id BIGINT,
  ADD COLUMN IF NOT EXISTS template_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS position_id BIGINT,
  ADD COLUMN IF NOT EXISTS department_id BIGINT,
  ADD COLUMN IF NOT EXISTS branch_id BIGINT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS reporting_manager BIGINT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS job_code TEXT,
  ADD COLUMN IF NOT EXISTS employee_category TEXT,
  ADD COLUMN IF NOT EXISTS probation_start_date DATE,
  ADD COLUMN IF NOT EXISTS probation_end_date DATE,
  ADD COLUMN IF NOT EXISTS probation_duration_days INTEGER,
  ADD COLUMN IF NOT EXISTS notice_period_days INTEGER,
  ADD COLUMN IF NOT EXISTS notice_basis TEXT,
  ADD COLUMN IF NOT EXISTS working_hours_per_week NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS working_days TEXT[],
  ADD COLUMN IF NOT EXISTS rest_days TEXT[],
  ADD COLUMN IF NOT EXISTS annual_leave_days INTEGER,
  ADD COLUMN IF NOT EXISTS salary_frequency TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (salary_frequency IN ('MONTHLY','WEEKLY','FORTNIGHTLY','HOURLY','DAILY','ANNUAL')),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN IF NOT EXISTS gross_salary NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS employer_rep_name TEXT,
  ADD COLUMN IF NOT EXISTS employer_rep_title TEXT,
  ADD COLUMN IF NOT EXISTS renewal_eligibility BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_notification_date DATE,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS previous_contract_id BIGINT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_for_signature_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signed_by_employee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signed_by_employer_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS doc_hash TEXT,
  ADD COLUMN IF NOT EXISTS document_path TEXT,
  ADD COLUMN IF NOT EXISTS executed_document_id BIGINT,
  ADD COLUMN IF NOT EXISTS content JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by BIGINT,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- backfill tenant/company/department/branch/job title from the employee
UPDATE employment_contracts ec
SET company_id = e.company_id,
    tenant_id = e.tenant_id,
    department_id = e.department_id,
    branch_id = e.branch_id,
    job_title = e.position,
    employee_category = CASE WHEN e.status = 'PROBATION' THEN 'PROBATION' ELSE 'REGULAR' END
FROM employees e
WHERE ec.employee_id = e.id AND ec.company_id IS NULL;

ALTER TABLE employment_contracts
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN tenant_id SET NOT NULL;

-- normalise legacy contract type codes into the new taxonomy
UPDATE employment_contracts
SET contract_type = CASE contract_type
  WHEN 'CONTRACT' THEN 'FIXED_TERM'
  WHEN 'PROBATION' THEN 'PROBATIONARY'
  ELSE contract_type END;

ALTER TABLE employment_contracts DROP CONSTRAINT IF EXISTS employment_contracts_contract_type_check;
ALTER TABLE employment_contracts ADD CONSTRAINT employment_contracts_contract_type_check
  CHECK (contract_type IN ('PERMANENT','FIXED_TERM','PROBATIONARY','PART_TIME','TEMPORARY',
    'APPRENTICESHIP','CASUAL','INTERNSHIP','CONSULTANCY','SECONDMENT','RENEWAL','VARIATION',
    'PROMOTION','TRANSFER','SALARY_ADJUSTMENT','OTHER'));

ALTER TABLE employment_contracts DROP CONSTRAINT IF EXISTS employment_contracts_status_check;
ALTER TABLE employment_contracts ADD CONSTRAINT employment_contracts_status_check
  CHECK (status IN ('DRAFT','VALIDATING','SUBMITTED','HR_REVIEW','MANAGER_REVIEW','FINANCE_REVIEW',
    'LEGAL_REVIEW','APPROVED','SENT_FOR_SIGNATURE','PARTIALLY_SIGNED','EXECUTED','ACTIVE','VARIED',
    'RENEWED','EXPIRED','TERMINATED','ARCHIVED','REJECTED'));

-- assign sequential contract numbers to historical rows
UPDATE employment_contracts ec
SET contract_no = next_contract_no(ec.tenant_id, ec.company_id, ec.contract_type, ec.start_date)
WHERE ec.contract_no IS NULL;

ALTER TABLE employment_contracts ALTER COLUMN contract_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employment_contracts_contract_no
  ON employment_contracts (company_id, contract_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employment_contracts_tenant ON employment_contracts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_employment_contracts_company ON employment_contracts (company_id);
CREATE INDEX IF NOT EXISTS idx_employment_contracts_employee ON employment_contracts (employee_id);
CREATE INDEX IF NOT EXISTS idx_employment_contracts_type_status ON employment_contracts (contract_type, status);
CREATE INDEX IF NOT EXISTS idx_employment_contracts_end_date ON employment_contracts (end_date) WHERE end_date IS NOT NULL;

-- auto-number new rows and resolve tenant/company from the employee when the
-- legacy HR services insert without explicit context columns
CREATE OR REPLACE FUNCTION employment_contracts_assign_no() RETURNS trigger AS $$
BEGIN
  IF NEW.company_id IS NULL OR NEW.tenant_id IS NULL THEN
    SELECT e.company_id, e.tenant_id, e.department_id, e.branch_id
      INTO NEW.company_id, NEW.tenant_id, NEW.department_id, NEW.branch_id
    FROM employees e WHERE e.id = NEW.employee_id;
  END IF;
  IF NEW.contract_no IS NULL OR btrim(NEW.contract_no) = '' THEN
    NEW.contract_no := next_contract_no(NEW.tenant_id, NEW.company_id, NEW.contract_type, COALESCE(NEW.start_date, CURRENT_DATE));
  END IF;
  IF NEW.version IS NULL THEN NEW.version := 1; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employment_contracts_assign_no ON employment_contracts;
CREATE TRIGGER trg_employment_contracts_assign_no BEFORE INSERT ON employment_contracts
  FOR EACH ROW EXECUTE FUNCTION employment_contracts_assign_no();
-- ============================================================
-- Contract templates & clauses
-- ============================================================
CREATE TABLE contract_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  contract_type TEXT,
  is_approved BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED','SUPERSEDED')),
  created_by BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (company_id, code)
);

CREATE TABLE contract_template_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  template_id BIGINT NOT NULL REFERENCES contract_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  content JSONB NOT NULL DEFAULT '[]'::jsonb,
  header TEXT,
  footer TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','ARCHIVED')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE contract_clauses (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  clause_code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED','SUPERSEDED')),
  effective_from DATE,
  effective_to DATE,
  legal_reference TEXT,
  legal_rule_id BIGINT,
  required_flag TEXT NOT NULL DEFAULT 'OPTIONAL' CHECK (required_flag IN ('REQUIRED','OPTIONAL','CONDITIONAL')),
  applicable_employee_types TEXT[],
  applicable_contract_types TEXT[],
  rule_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts_with TEXT[],
  created_by BIGINT,
  approved_by BIGINT,
  approval_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (company_id, clause_code, version)
);

CREATE TABLE contract_clause_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  clause_id BIGINT NOT NULL REFERENCES contract_clauses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  effective_from DATE,
  effective_to DATE,
  legal_reference TEXT,
  legal_rule_id BIGINT,
  required_flag TEXT NOT NULL DEFAULT 'OPTIONAL',
  applicable_employee_types TEXT[],
  applicable_contract_types TEXT[],
  rule_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts_with TEXT[],
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clause_id, version)
);
-- ============================================================
-- Variables, sections, signatures, approvals
-- ============================================================
CREATE TABLE contract_variables (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  source TEXT,
  data_type TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('text','number','date','boolean','money','list')),
  is_required BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE contract_sections (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE contract_signatures (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  signer_type TEXT NOT NULL CHECK (signer_type IN ('EMPLOYEE','EMPLOYER_REPRESENTATIVE','WITNESS','HR_VERIFIER')),
  signer_user_id BIGINT,
  signer_name TEXT,
  signer_email TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_SENT'
    CHECK (status IN ('NOT_SENT','SENT','VIEWED','SIGNED','REJECTED','EXPIRED','REVOKED')),
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  signature TEXT,
  doc_hash TEXT,
  verification_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_signatures_contract ON contract_signatures (contract_id);

CREATE TABLE contract_approvals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  workflow_instance_id BIGINT,
  step_seq INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  approver_role TEXT,
  approver_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
  comments TEXT,
  decided_by BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, step_seq)
);
CREATE INDEX idx_contract_approvals_contract ON contract_approvals (contract_id);
-- ============================================================
-- Variations, renewals, documents, notifications
-- ============================================================
CREATE TABLE contract_variations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id),
  variation_no TEXT NOT NULL,
  variation_type TEXT NOT NULL
    CHECK (variation_type IN ('SALARY','JOB_TITLE','DEPARTMENT_TRANSFER','WORKPLACE_TRANSFER',
      'WORKING_HOURS','ALLOWANCE','BENEFITS','PROMOTION','DEMOTION','REPORTING_LINE',
      'CONTRACT_EXTENSION','CONTRACT_RENEWAL','OTHER')),
  reason TEXT,
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_date DATE,
  new_contract_id BIGINT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','APPLIED','ARCHIVED')),
  created_by BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, variation_no)
);

CREATE TABLE contract_renewals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id),
  renewal_no TEXT NOT NULL,
  new_start_date DATE NOT NULL,
  new_end_date DATE,
  reason TEXT,
  renewal_eligibility BOOLEAN NOT NULL DEFAULT true,
  new_contract_id BIGINT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','APPLIED','ARCHIVED')),
  created_by BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, renewal_no)
);

CREATE TABLE contract_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT REFERENCES employment_contracts(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('DRAFT_COPY','FINAL_COPY','EXECUTED_COPY','VARIATION','RENEWAL',
      'CERTIFICATE_OF_SERVICE','PROMOTION_LETTER','SALARY_LETTER','TRANSFER_LETTER','OTHER')),
  document_no TEXT,
  file_name TEXT,
  file_path TEXT,
  mime_type TEXT,
  file_size BIGINT,
  doc_hash TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL','EXECUTED','ARCHIVED')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, document_no)
);

CREATE TABLE contract_document_access_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  document_id BIGINT REFERENCES contract_documents(id) ON DELETE SET NULL,
  user_id BIGINT,
  action TEXT NOT NULL CHECK (action IN ('VIEW','DOWNLOAD','PRINT','SIGN','VERIFY','PREVIEW')),
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contract_notifications (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT REFERENCES employment_contracts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('EMAIL','SMS','IN_APP','PUSH')),
  recipient_user_id BIGINT,
  recipient_email TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_notifications_contract ON contract_notifications (contract_id);
-- ============================================================
-- Employment types, terms, probation, compensation
-- ============================================================
CREATE TABLE employment_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_employment BOOLEAN NOT NULL DEFAULT true,
  max_duration_days INTEGER,
  notice_basis TEXT,
  warning TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE employment_terms (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  term_type TEXT NOT NULL
    CHECK (term_type IN ('CLAUSE','PARTICULAR','CUSTOM')),
  title TEXT NOT NULL,
  description TEXT,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  clause_id BIGINT,
  clause_version INTEGER,
  legal_reference TEXT,
  statutory_min TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employment_terms_contract ON employment_terms (contract_id);

CREATE TABLE probation_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  duration_days INTEGER NOT NULL,
  review_30_day DATE,
  review_60_day DATE,
  review_final_date DATE,
  extension_days INTEGER,
  extension_reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ON_REVIEW','EXTENDED','CONFIRMED','ENDED')),
  outcome TEXT CHECK (outcome IN ('CONFIRMED','EXTENDED','ENDED')),
  confirmation_date DATE,
  confirmed_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_probation_records_contract ON probation_records (contract_id);

CREATE TABLE salary_contract_terms (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL
    CHECK (component_type IN ('BASIC','GROSS','ALLOWANCE','BENEFIT','COMMISSION','BONUS','OTHER')),
  name TEXT NOT NULL,
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  currency TEXT NOT NULL DEFAULT 'UGX',
  taxable BOOLEAN NOT NULL DEFAULT true,
  payroll_treatment TEXT,
  effective_date DATE,
  end_date DATE,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_salary_contract_terms_contract ON salary_contract_terms (contract_id);

CREATE TABLE contract_benefits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  benefit_type TEXT NOT NULL,
  name TEXT,
  employer_cost NUMERIC(18,2),
  employee_contribution NUMERIC(18,2),
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  currency TEXT NOT NULL DEFAULT 'UGX',
  taxable BOOLEAN NOT NULL DEFAULT false,
  effective_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contract_allowances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  allowance_type TEXT NOT NULL,
  name TEXT,
  amount NUMERIC(18,2),
  percentage NUMERIC(8,4),
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  currency TEXT NOT NULL DEFAULT 'UGX',
  taxable BOOLEAN NOT NULL DEFAULT true,
  payroll_treatment TEXT,
  effective_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ============================================================
-- Legal rules, compliance, certificates, verification
-- ============================================================
CREATE TABLE legal_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  law TEXT NOT NULL DEFAULT 'Employment Act, 2006',
  law_chapter TEXT NOT NULL DEFAULT 'Chapter 226',
  section TEXT,
  description TEXT,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','DRAFT')),
  enforcement TEXT NOT NULL DEFAULT 'HARD' CHECK (enforcement IN ('HARD','SOFT','ADVISORY')),
  effective_from DATE,
  effective_to DATE,
  source TEXT,
  created_by BIGINT,
  approved_by BIGINT,
  approval_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);
CREATE INDEX idx_legal_rules_tenant_code ON legal_rules (tenant_id, code);

CREATE TABLE legal_rule_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  rule_id BIGINT NOT NULL REFERENCES legal_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  law TEXT NOT NULL,
  law_chapter TEXT NOT NULL,
  section TEXT,
  description TEXT,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  enforcement TEXT NOT NULL DEFAULT 'HARD',
  effective_from DATE,
  effective_to DATE,
  source TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version)
);

CREATE TABLE compliance_checks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contract_id BIGINT NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('GREEN','AMBER','RED')),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_by BIGINT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_compliance_checks_contract ON compliance_checks (contract_id);

CREATE TABLE certificate_of_service (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  cert_no TEXT NOT NULL,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  contract_id BIGINT REFERENCES employment_contracts(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  nature_of_business TEXT,
  position TEXT,
  wages_at_termination NUMERIC(18,2),
  reason_for_termination TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','ARCHIVED')),
  doc_hash TEXT,
  created_by BIGINT,
  issued_by BIGINT,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, cert_no)
);

CREATE TABLE document_verification (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  document_no TEXT NOT NULL,
  document_type TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  doc_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  first_verified_at TIMESTAMPTZ,
  verify_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_document_verification_code ON document_verification (company_id, verification_code);
-- ============================================================
-- Foreign keys, triggers, RLS
-- ============================================================
ALTER TABLE employment_contracts
  DROP CONSTRAINT IF EXISTS fk_employment_contracts_previous,
  DROP CONSTRAINT IF EXISTS fk_employment_contracts_executed_doc;
ALTER TABLE employment_contracts
  ADD CONSTRAINT fk_employment_contracts_previous FOREIGN KEY (previous_contract_id)
    REFERENCES employment_contracts(id),
  ADD CONSTRAINT fk_employment_contracts_executed_doc FOREIGN KEY (executed_document_id)
    REFERENCES contract_documents(id);
ALTER TABLE contract_variations
  DROP CONSTRAINT IF EXISTS fk_contract_variations_new_contract;
ALTER TABLE contract_variations
  ADD CONSTRAINT fk_contract_variations_new_contract FOREIGN KEY (new_contract_id)
    REFERENCES employment_contracts(id);
ALTER TABLE contract_renewals
  DROP CONSTRAINT IF EXISTS fk_contract_renewals_new_contract;
ALTER TABLE contract_renewals
  ADD CONSTRAINT fk_contract_renewals_new_contract FOREIGN KEY (new_contract_id)
    REFERENCES employment_contracts(id);

-- updated_at triggers for every new table carrying the column
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('contract_templates','contract_template_versions','contract_clauses',
        'contract_clause_versions','contract_variables','contract_sections','contract_signatures',
        'contract_approvals','contract_variations','contract_renewals','contract_documents',
        'employment_types','employment_terms','probation_records','salary_contract_terms',
        'contract_benefits','contract_allowances','legal_rules','legal_rule_versions',
        'certificate_of_service','document_verification')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- DB-level audit triggers on sensitive contract tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employment_contracts','contract_templates','contract_template_versions','contract_clauses',
    'contract_clause_versions','contract_signatures','contract_approvals','contract_variations',
    'contract_renewals','contract_documents','probation_records','salary_contract_terms',
    'contract_benefits','contract_allowances','legal_rules','legal_rule_versions',
    'compliance_checks','certificate_of_service','document_verification'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;
-- ---------- Row-level security: tenant isolation ----------
ALTER TABLE contract_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clause_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_document_access_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE probation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_contract_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_of_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_verification ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contract_number_counters','contract_templates','contract_template_versions','contract_clauses',
    'contract_clause_versions','contract_variables','contract_sections','contract_signatures',
    'contract_approvals','contract_variations','contract_renewals','contract_documents',
    'contract_document_access_logs','contract_notifications','employment_types','employment_terms',
    'probation_records','salary_contract_terms','contract_benefits','contract_allowances',
    'legal_rules','legal_rule_versions','compliance_checks','certificate_of_service',
    'document_verification'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public'
        AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;
