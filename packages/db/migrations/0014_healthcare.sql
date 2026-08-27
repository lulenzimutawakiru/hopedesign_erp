-- ============================================================
-- 0014 Healthcare ERP layer (HealthCERP)
-- Multi-tenant healthcare: org types, module activation,
-- patient records, EMR, pharmacy, laboratory, insurance, billing.
-- ============================================================

-- ---------- Org model extension ----------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS activate_modules JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS org_type TEXT NOT NULL DEFAULT 'CORPORATE'
  CHECK (org_type IN ('CORPORATE','HOSPITAL','HEALTH_CENTRE','CLINIC','PHARMACY','DRUG_SHOP','LABORATORY'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS specialty TEXT;
CREATE INDEX IF NOT EXISTS idx_companies_org_type ON companies(org_type);

-- ---------- Extend product catalogue for pharmaceuticals ----------
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'products'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%JUMBO_ROLL%';
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', cname); END IF;
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'product_categories'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%RAW_MATERIAL%';
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE product_categories DROP CONSTRAINT %I', cname); END IF;
END $$;

ALTER TABLE products ADD CONSTRAINT products_type_check CHECK (type IN (
  'JUMBO_ROLL','PAPER_BOBBIN','SHEET','REAM','FINISHED_GOODS','PACKAGING','CONSUMABLE',
  'SPARE_PART','SECURITY_ITEM','SERVICE','DRUG','MEDICAL_SUPPLY','LAB_REAGENT','VACCINE'));

ALTER TABLE product_categories ADD CONSTRAINT product_categories_kind_check CHECK (kind IN (
  'RAW_MATERIAL','WIP','FINISHED_GOODS','PACKAGING','CONSUMABLE','SPARE_PART','SERVICE',
  'SECURITY_ITEM','PHARMACEUTICAL','MEDICAL_SUPPLY','LAB_REAGENT'));

-- ---------- Care facilities ----------
CREATE TABLE care_facilities (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  facility_type TEXT NOT NULL DEFAULT 'CLINIC'
    CHECK (facility_type IN ('HOSPITAL','HEALTH_CENTRE','CLINIC','PHARMACY','DRUG_SHOP','LABORATORY')),
  address TEXT,
  phone TEXT,
  email TEXT,
  manager_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_care_facilities_type ON care_facilities(company_id, facility_type);

-- ---------- Wards / beds ----------
CREATE TABLE wards (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  facility_id BIGINT REFERENCES care_facilities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  ward_type TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (ward_type IN ('GENERAL','MATERNITY','PEDIATRIC','SURGICAL','ICU','ISOLATION','EMERGENCY','OTHER')),
  capacity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','FULL')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE beds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  ward_id BIGINT NOT NULL REFERENCES wards(id),
  code TEXT NOT NULL,
  bed_type TEXT NOT NULL DEFAULT 'STANDARD'
    CHECK (bed_type IN ('STANDARD','ICU','INCUBATOR','WHEELCHAIR','RECOVERY')),
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE','CLEANING')),
  qr_id BIGINT,
  UNIQUE (company_id, ward_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_beds_status ON beds(ward_id, status);

-- ---------- Practitioners / medical staff ----------
CREATE TABLE practitioners (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  practitioner_no TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id),
  employee_id BIGINT REFERENCES employees(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  practitioner_type TEXT NOT NULL DEFAULT 'DOCTOR'
    CHECK (practitioner_type IN ('DOCTOR','NURSE','PHARMACIST','LAB_TECHNICIAN','RADIOLOGIST','CLINICAL_OFFICER','MIDWIFE','OTHER')),
  specialization TEXT,
  license_no TEXT,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_LEAVE','INACTIVE')),
  UNIQUE (company_id, practitioner_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Patients ----------
CREATE TABLE patients (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  patient_no TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth DATE,
  gender TEXT CHECK (gender IN ('MALE','FEMALE','OTHER')),
  blood_group TEXT DEFAULT 'UNKNOWN'
    CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','UNKNOWN')),
  phone TEXT,
  email TEXT,
  address TEXT,
  nationality TEXT,
  next_of_kin JSONB NOT NULL DEFAULT '{}'::jsonb,
  allergies JSONB NOT NULL DEFAULT '[]'::jsonb,
  chronic_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  registration_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','DECEASED','TRANSFERRED')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, patient_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_patients_name ON patients(last_name, first_name);
CREATE INDEX idx_patients_status ON patients(status);

-- Link beds to a currently admitted patient (added after patients table exists)
ALTER TABLE beds ADD COLUMN IF NOT EXISTS current_patient_id BIGINT REFERENCES patients(id);

-- ---------- Patient visits ----------
CREATE TABLE patient_visits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  visit_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_type TEXT NOT NULL DEFAULT 'OUTPATIENT'
    CHECK (visit_type IN ('OUTPATIENT','INPATIENT','EMERGENCY','FOLLOW_UP','TELEHEALTH')),
  status TEXT NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('REGISTERED','CHECKED_IN','TRIAGED','IN_PROGRESS','ADMITTED','COMPLETED','DISCHARGED','CANCELLED')),
  admitted_bed_id BIGINT REFERENCES beds(id),
  attending_practitioner_id BIGINT REFERENCES practitioners(id),
  complaint TEXT,
  checked_in_at TIMESTAMPTZ,
  triaged_at TIMESTAMPTZ,
  admitted_at TIMESTAMPTZ,
  discharged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  discharge_summary TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, visit_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_visits_patient ON patient_visits(patient_id, created_at DESC);
CREATE INDEX idx_visits_status ON patient_visits(status);

-- ---------- Appointments ----------
CREATE TABLE appointments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  appointment_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  practitioner_id BIGINT REFERENCES practitioners(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 15,
  appointment_type TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (appointment_type IN ('GENERAL','FOLLOW_UP','SPECIALIST','VACCINATION','ANTENATAL','CHECKUP','LAB','OTHER')),
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW')),
  reason TEXT,
  UNIQUE (company_id, appointment_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_scheduled ON appointments(scheduled_at);

-- ---------- Electronic medical records ----------
CREATE TABLE electronic_medical_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  emr_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  practitioner_id BIGINT REFERENCES practitioners(id),
  record_type TEXT NOT NULL DEFAULT 'CONSULTATION'
    CHECK (record_type IN ('CONSULTATION','NURSING_NOTES','VITALS','DIAGNOSIS','PRESCRIPTION','LAB_RESULT','PROCEDURE','IMMUNIZATION','REFERRAL','ADMISSION_NOTE','DISCHARGE_SUMMARY','OTHER')),
  title TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  clinical_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_confidential BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL','AMENDED','ARCHIVED')),
  UNIQUE (company_id, emr_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_emr_patient ON electronic_medical_records(patient_id, clinical_date DESC);

-- ---------- Diagnoses / vitals / nursing ----------
CREATE TABLE diagnoses (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  emr_id BIGINT REFERENCES electronic_medical_records(id),
  icd_code TEXT,
  description TEXT NOT NULL,
  diagnosis_type TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK (diagnosis_type IN ('PROVISIONAL','CONFIRMED','DIFFERENTIAL','RULED_OUT')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED','INACTIVE')),
  diagnosed_by BIGINT REFERENCES practitioners(id),
  diagnosed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vitals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  emr_id BIGINT REFERENCES electronic_medical_records(id),
  recorded_by BIGINT REFERENCES users(id),
  temperature_c NUMERIC(5,2),
  systolic_mmhg INTEGER,
  diastolic_mmhg INTEGER,
  heart_rate_bpm INTEGER,
  respiratory_rate INTEGER,
  oxygen_saturation_pct NUMERIC(5,2),
  weight_kg NUMERIC(8,2),
  height_cm NUMERIC(8,2),
  bmi NUMERIC(6,2),
  notes TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE nursing_observations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  bed_id BIGINT REFERENCES beds(id),
  observed_by BIGINT REFERENCES users(id),
  observation_type TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (observation_type IN ('GENERAL','FLUID_BALANCE','WOUND_CARE','MEDICATION','FALL_RISK','BEHAVIOUR','OTHER')),
  observation JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Prescriptions / dispensings ----------
CREATE TABLE prescriptions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  prescription_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  practitioner_id BIGINT NOT NULL REFERENCES practitioners(id),
  diagnosis_id BIGINT REFERENCES diagnoses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','DISPENSED','PARTIALLY_DISPENSED','CANCELLED','REJECTED')),
  notes TEXT,
  UNIQUE (company_id, prescription_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prescriptions_patient ON prescriptions(patient_id, status);

CREATE TABLE prescription_items (
  id BIGSERIAL PRIMARY KEY,
  prescription_id BIGINT NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id),
  unit_id BIGINT REFERENCES units(id),
  drug_name TEXT NOT NULL,
  strength TEXT,
  dosage_form TEXT,
  dosage_instruction TEXT,
  frequency TEXT,
  duration_days INTEGER,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  dispensed_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','DISPENSED','PARTIAL','NOT_AVAILABLE','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dispensings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  dispensing_no TEXT NOT NULL,
  prescription_id BIGINT NOT NULL REFERENCES prescriptions(id),
  prescription_item_id BIGINT REFERENCES prescription_items(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  quantity NUMERIC(18,4) NOT NULL,
  dispensed_by BIGINT REFERENCES users(id),
  dispensed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','VOID')),
  UNIQUE (company_id, dispensing_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Laboratory ----------
CREATE TABLE lab_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  request_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  emr_id BIGINT REFERENCES electronic_medical_records(id),
  requested_by BIGINT REFERENCES practitioners(id),
  priority TEXT NOT NULL DEFAULT 'ROUTINE' CHECK (priority IN ('ROUTINE','URGENT','STAT')),
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','COLLECTED','IN_PROGRESS','COMPLETED','CANCELLED','REJECTED')),
  clinical_note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_at TIMESTAMPTZ,
  UNIQUE (company_id, request_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_requests_status ON lab_requests(status);

CREATE TABLE lab_request_tests (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES lab_requests(id) ON DELETE CASCADE,
  test_code TEXT NOT NULL,
  test_name TEXT NOT NULL,
  specimen_type TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','COLLECTED','IN_PROGRESS','COMPLETED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lab_results (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  result_no TEXT NOT NULL,
  request_id BIGINT NOT NULL REFERENCES lab_requests(id),
  test_code TEXT NOT NULL,
  test_name TEXT NOT NULL,
  result_value TEXT,
  unit TEXT,
  reference_range TEXT,
  is_abnormal BOOLEAN NOT NULL DEFAULT false,
  performed_by BIGINT REFERENCES users(id),
  reviewed_by BIGINT REFERENCES practitioners(id),
  performed_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','REVIEWED','AMENDED')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, result_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_results_request ON lab_results(request_id);

-- ---------- Insurance ----------
CREATE TABLE insurance_payers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  payer_type TEXT NOT NULL DEFAULT 'PRIVATE'
    CHECK (payer_type IN ('HMO','NHIF','PRIVATE','EMPLOYER','GOVERNMENT','OTHER')),
  contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE insurance_claims (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  claim_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  payer_id BIGINT NOT NULL REFERENCES insurance_payers(id),
  claim_type TEXT NOT NULL DEFAULT 'OUTPATIENT'
    CHECK (claim_type IN ('OUTPATIENT','INPATIENT','PHARMACY','LABORATORY','MATERNITY','EMERGENCY','OTHER')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  approved_amount NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','ADJUDICATED','APPROVED','REJECTED','PAID','VOID')),
  submitted_at TIMESTAMPTZ,
  adjudicated_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  paid_journal_id BIGINT,
  notes TEXT,
  UNIQUE (company_id, claim_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_claims_status ON insurance_claims(status, payer_id);

-- ---------- Healthcare billing ----------
CREATE TABLE healthcare_bills (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  bill_no TEXT NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  visit_id BIGINT REFERENCES patient_visits(id),
  bill_type TEXT NOT NULL DEFAULT 'CONSULTATION'
    CHECK (bill_type IN ('CONSULTATION','PHARMACY','LABORATORY','PROCEDURE','ADMISSION','INSURANCE','OTHER')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  payer_type TEXT NOT NULL DEFAULT 'CASH' CHECK (payer_type IN ('CASH','INSURANCE','NHIF','BANK')),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING','POSTED','PARTIALLY_PAID','PAID','VOID')),
  journal_id BIGINT,
  paid_at TIMESTAMPTZ,
  UNIQUE (company_id, bill_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_healthcare_bills_status ON healthcare_bills(status);

-- ---------- Extend QR system for healthcare entities ----------
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'qr_codes'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%RAW_MATERIAL%';
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE qr_codes DROP CONSTRAINT %I', cname); END IF;
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'label_templates'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%WORK_ORDER%';
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE label_templates DROP CONSTRAINT %I', cname); END IF;
END $$;

ALTER TABLE qr_codes ADD CONSTRAINT qr_codes_entity_type_check CHECK (entity_type IN (
  'PRODUCT','BATCH','LOT','SERIAL','WORK_ORDER','SECURITY_JOB','CARTON','PALLET','ASSET',
  'MACHINE','BIN','DELIVERY','CUSTOMER','RAW_MATERIAL','PATIENT','PRACTITIONER',
  'CARE_FACILITY','WARD','BED'));

ALTER TABLE label_templates ADD CONSTRAINT label_templates_kind_check CHECK (kind IN (
  'PRODUCT','BATCH','CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','WORK_ORDER',
  'PATIENT','PRACTITIONER','CARE_FACILITY','WARD','BED'));

-- ---------- Healthcare overview view (read model for dashboards) ----------
CREATE OR REPLACE VIEW v_healthcare_overview AS
SELECT
  p.id AS patient_id, p.patient_no, p.first_name, p.last_name, p.gender, p.status AS patient_status,
  v.id AS visit_id, v.visit_no, v.visit_type, v.status AS visit_status,
  v.admitted_bed_id, b.ward_id, w.name AS ward_name,
  pr.id AS practitioner_id, pr.first_name AS practitioner_first_name, pr.last_name AS practitioner_last_name,
  v.complaint, v.admitted_at, v.discharged_at, v.checked_in_at,
  p.company_id, p.tenant_id, p.branch_id
FROM patients p
LEFT JOIN patient_visits v ON v.patient_id = p.id
LEFT JOIN beds b ON b.id = v.admitted_bed_id
LEFT JOIN wards w ON w.id = b.ward_id
LEFT JOIN practitioners pr ON pr.id = v.attending_practitioner_id;

-- ---------- Row-level security ----------
ALTER TABLE care_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE wards ENABLE ROW LEVEL SECURITY;
ALTER TABLE beds ENABLE ROW LEVEL SECURITY;
ALTER TABLE practitioners ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE electronic_medical_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE vitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nursing_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispensings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_request_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthcare_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON care_facilities USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON wards USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON beds USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON practitioners USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON patients USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON patient_visits USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON appointments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON electronic_medical_records USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON diagnoses USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON vitals USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON nursing_observations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON prescriptions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON prescription_items USING (prescription_id IN (SELECT id FROM prescriptions));
CREATE POLICY tenant_isolation ON dispensings USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON lab_requests USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON lab_request_tests USING (request_id IN (SELECT id FROM lab_requests));
CREATE POLICY tenant_isolation ON lab_results USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON insurance_payers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON insurance_claims USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON healthcare_bills USING (tenant_id = app_tenant_id());