-- ============================================================
-- 0067 Enterprise Asset Management (HOPE DESIGN GROUP LTD)
-- Asset Register, Tagging & Tracking with full lifecycle:
-- PROCUREMENT -> RECEIVING -> REGISTRATION -> TAGGING ->
-- ASSIGNMENT -> LOCATION -> USE -> TRANSFER -> MAINTENANCE ->
-- AUDIT -> DEPRECIATION -> IMPAIRMENT -> DISPOSAL -> RETIREMENT.
-- Every asset carries a permanent, never-reused asset number,
-- an opaque QR identity, custody/location/timeline history and a
-- DB-level audit trail. Controlled records use lifecycle actions;
-- destructive deletes are never allowed on the master register.
-- ============================================================

-- ---------- 1. Asset numbering ----------
-- Default prefix mapper: company -> HDG-AST. Administrators may
-- override via asset_sequence_rules (per company/branch/category).
CREATE OR REPLACE FUNCTION asset_number_prefix(p_company bigint) RETURNS text AS $$
DECLARE
  v_code text;
BEGIN
  SELECT code INTO v_code FROM companies WHERE id = p_company;
  RETURN COALESCE(v_code, 'HDG') || '-AST';
END;
$$ LANGUAGE plpgsql STABLE;

-- Sequence-aware asset number. Rule lookup order (most specific wins):
-- (company, branch, category) -> (company, branch) -> (company) -> default.
CREATE OR REPLACE FUNCTION next_asset_no(
  p_tenant bigint, p_company bigint, p_branch bigint DEFAULT NULL, p_category bigint DEFAULT NULL
) RETURNS text AS $$
DECLARE
  v_prefix text := asset_number_prefix(p_company);
  v_pad integer := 6;
BEGIN
  SELECT prefix, pad
    INTO v_prefix, v_pad
  FROM asset_sequence_rules
  WHERE tenant_id = p_tenant AND is_active = true
    AND (company_id = p_company OR company_id IS NULL)
    AND (branch_id = p_branch OR branch_id IS NULL)
    AND (category_id = p_category OR category_id IS NULL)
  ORDER BY
    (company_id IS NOT NULL)::int + (branch_id IS NOT NULL)::int + (category_id IS NOT NULL)::int DESC,
    id DESC
  LIMIT 1;
  RETURN next_doc_no(p_tenant, v_prefix, v_pad);
END;
$$ LANGUAGE plpgsql;

-- Status transition guard: no arbitrary status changes. Legal moves are
-- the registration/approval path, custody and operational transitions,
-- controlled issue states and terminal states. Any other transition fails.
CREATE OR REPLACE FUNCTION asset_status_transition_ok(p_from text, p_to text) RETURNS boolean AS $$
BEGIN
  IF p_from = p_to THEN RETURN true; END IF;
  IF p_from IN ('DRAFT','PENDING_APPROVAL') AND p_to IN ('REGISTERED','IN_STORE','AVAILABLE','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('REGISTERED','IN_STORE','AVAILABLE') AND p_to IN ('ASSIGNED','IN_USE','UNDER_MAINTENANCE','UNDER_INSPECTION','RESERVED','QUARANTINED','TRANSFERRED','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('ASSIGNED','IN_USE') AND p_to IN ('AVAILABLE','IN_STORE','UNDER_MAINTENANCE','UNDER_INSPECTION','TRANSFERRED','MISSING','DAMAGED','QUARANTINED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('UNDER_MAINTENANCE','UNDER_INSPECTION') AND p_to IN ('AVAILABLE','ASSIGNED','IN_USE','IN_STORE','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from = 'TRANSFERRED' AND p_to IN ('ASSIGNED','IN_USE','AVAILABLE','IN_STORE','UNDER_MAINTENANCE','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('MISSING','LOST','STOLEN') AND p_to IN ('AVAILABLE','ASSIGNED','IN_USE','IN_STORE','DAMAGED','DISPOSED','RETIRED','ARCHIVED','QUARANTINED') THEN RETURN true; END IF;
  IF p_from IN ('DAMAGED','QUARANTINED') AND p_to IN ('UNDER_MAINTENANCE','UNDER_INSPECTION','AVAILABLE','ASSIGNED','IN_USE','DISPOSED','RETIRED','ARCHIVED','MISSING') THEN RETURN true; END IF;
  IF p_from = 'RESERVED' AND p_to IN ('ASSIGNED','IN_USE','AVAILABLE','IN_STORE','UNDER_MAINTENANCE','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_to IN ('DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF; -- terminal transition via disposal workflow
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- 2. Reference data ----------
-- Extend the legacy asset_categories table (kept for backwards
-- compatibility with HR asset records) with hierarchy + typing columns.
ALTER TABLE asset_categories
  ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES asset_categories(id),
  ADD COLUMN IF NOT EXISTS asset_type TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT;
CREATE INDEX IF NOT EXISTS idx_asset_categories_parent ON asset_categories(parent_id);

CREATE TABLE asset_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  category_id BIGINT REFERENCES asset_categories(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE asset_classes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE asset_statuses (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE asset_conditions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Hierarchical locations: COMPANY -> BRANCH -> BUILDING -> FLOOR ->
-- DEPARTMENT -> ROOM -> RACK_BIN. Every change is recorded.
CREATE TABLE asset_locations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  parent_id BIGINT REFERENCES asset_locations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'LOCATION'
    CHECK (level IN ('COMPANY','BRANCH','BUILDING','FLOOR','DEPARTMENT','ROOM','RACK_BIN','LOCATION')),
  branch_id BIGINT REFERENCES branches(id),
  building TEXT,
  floor TEXT,
  room TEXT,
  rack_bin TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_asset_locations_parent ON asset_locations(parent_id);
CREATE INDEX IF NOT EXISTS idx_asset_locations_branch ON asset_locations(branch_id);

CREATE TABLE asset_sequence_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  category_id BIGINT REFERENCES asset_categories(id),
  prefix TEXT NOT NULL DEFAULT 'HDG-AST',
  pad INTEGER NOT NULL DEFAULT 6 CHECK (pad BETWEEN 4 AND 12),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 3. Asset master register ----------
CREATE TABLE asset_register (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  asset_no TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id BIGINT REFERENCES asset_categories(id),
  type_id BIGINT REFERENCES asset_types(id),
  class_id BIGINT REFERENCES asset_classes(id),
  description TEXT,
  manufacturer TEXT,
  model TEXT,
  serial_no TEXT,
  part_no TEXT,
  sku TEXT,
  barcode TEXT,
  qr_id BIGINT REFERENCES qr_codes(id),
  is_machine BOOLEAN NOT NULL DEFAULT false,
  machine_ref TEXT,
  is_high_value BOOLEAN NOT NULL DEFAULT false,
  is_serialized BOOLEAN NOT NULL DEFAULT true,
  -- Organisational
  department_id BIGINT REFERENCES departments(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  project_id BIGINT REFERENCES projects(id),
  location_id BIGINT REFERENCES asset_locations(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  floor TEXT,
  room TEXT,
  building TEXT,
  -- Custody (current snapshot; full ledger in asset_custody)
  custodian_user_id BIGINT REFERENCES users(id),
  custodian_employee_id BIGINT REFERENCES employees(id),
  custodian_department_id BIGINT REFERENCES departments(id),
  assigned_date DATE,
  expected_return_date DATE,
  custody_status TEXT NOT NULL DEFAULT 'UNASSIGNED'
    CHECK (custody_status IN ('UNASSIGNED','ASSIGNED','PENDING_RETURN','OVERDUE','IN_TRANSIT')),
  -- Financial
  purchase_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  purchase_date DATE,
  supplier_id BIGINT REFERENCES suppliers(id),
  po_id BIGINT REFERENCES purchase_orders(id),
  po_number TEXT,
  invoice_id BIGINT REFERENCES supplier_invoices(id),
  invoice_number TEXT,
  grn_id BIGINT REFERENCES goods_receipts(id),
  grn_number TEXT,
  capitalization_date DATE,
  useful_life_months INTEGER,
  residual_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  depreciation_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE'
    CHECK (depreciation_method IN ('STRAIGHT_LINE','REDUCING_BALANCE','UNITS_OF_PRODUCTION','CUSTOM','NONE')),
  accumulated_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0,
  current_book_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  capitalized BOOLEAN NOT NULL DEFAULT false,
  -- Operational
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING_APPROVAL','REGISTERED','IN_STORE','AVAILABLE','ASSIGNED','IN_USE',
      'TRANSFERRED','UNDER_MAINTENANCE','UNDER_INSPECTION','MISSING','LOST','STOLEN','DAMAGED','QUARANTINED',
      'RESERVED','DISPOSED','RETIRED','ARCHIVED')),
  condition TEXT NOT NULL DEFAULT 'NEW'
    CHECK (condition IN ('NEW','EXCELLENT','GOOD','FAIR','POOR','DAMAGED','CRITICAL','UNDER_REPAIR','BEYOND_ECONOMIC_REPAIR','DISPOSED')),
  operational_state TEXT NOT NULL DEFAULT 'NOT_IN_USE'
    CHECK (operational_state IN ('NOT_IN_USE','OPERATIONAL','RUNNING','IDLE','FAULTED','DECOMMISSIONED')),
  warranty_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (warranty_status IN ('UNKNOWN','IN_WARRANTY','EXPIRING_SOON','EXPIRED','NONE')),
  insurance_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (insurance_status IN ('UNKNOWN','INSURED','EXPIRING_SOON','EXPIRED','NONE')),
  maintenance_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (maintenance_status IN ('NONE','NONE_DUE','DUE','OVERDUE','IN_PROGRESS')),
  last_inspection DATE,
  next_inspection DATE,
  last_maintenance DATE,
  next_maintenance DATE,
  last_scan_at TIMESTAMPTZ,
  last_scan_location_id BIGINT REFERENCES asset_locations(id),
  last_scan_user_id BIGINT REFERENCES users(id),
  last_verified_at TIMESTAMPTZ,
  last_verified_by BIGINT REFERENCES users(id),
  eol_date DATE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, asset_no)
);
CREATE INDEX idx_asset_register_status ON asset_register(status);
CREATE INDEX idx_asset_register_condition ON asset_register(condition);
CREATE INDEX idx_asset_register_category ON asset_register(category_id);
CREATE INDEX idx_asset_register_location ON asset_register(location_id);
CREATE INDEX idx_asset_register_custodian ON asset_register(custodian_user_id);
CREATE INDEX idx_asset_register_department ON asset_register(department_id);
CREATE INDEX idx_asset_register_branch ON asset_register(branch_id);
CREATE INDEX idx_asset_register_serial ON asset_register(serial_no);
CREATE INDEX idx_asset_register_barcode ON asset_register(barcode);
CREATE INDEX idx_asset_register_qr ON asset_register(qr_id);
CREATE INDEX idx_asset_register_search ON asset_register(asset_no, name);

-- asset_no is permanent: it must never change after creation.
CREATE OR REPLACE FUNCTION asset_register_no_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.asset_no IS DISTINCT FROM NEW.asset_no THEN
    RAISE EXCEPTION 'Asset number % is permanent and cannot be changed', OLD.asset_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Status changes must follow controlled transitions.
CREATE OR REPLACE FUNCTION asset_register_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT asset_status_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Invalid asset status transition: % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_register_no_immutable ON asset_register;
CREATE TRIGGER trg_asset_register_no_immutable
  BEFORE UPDATE OF asset_no ON asset_register
  FOR EACH ROW EXECUTE FUNCTION asset_register_no_immutable();

DROP TRIGGER IF EXISTS trg_asset_register_status_guard ON asset_register;
CREATE TRIGGER trg_asset_register_status_guard
  BEFORE UPDATE OF status ON asset_register
  FOR EACH ROW EXECUTE FUNCTION asset_register_status_guard();

-- Prevent hard deletes of controlled records: RLS blocks it anyway, and this
-- trigger guarantees traceability even for privileged connections.
CREATE OR REPLACE FUNCTION asset_register_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Asset records are never physically deleted; use RETIRED/ARCHIVED lifecycle actions';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_register_no_delete ON asset_register;
CREATE TRIGGER trg_asset_register_no_delete
  BEFORE DELETE ON asset_register
  FOR EACH ROW EXECUTE FUNCTION asset_register_no_delete();

-- ---------- 4. Asset tags (QR / barcode / NFC-ready) ----------
CREATE TABLE asset_tags (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  qr_id BIGINT NOT NULL REFERENCES qr_codes(id),
  tag_no TEXT NOT NULL,
  tag_type TEXT NOT NULL DEFAULT 'QR'
    CHECK (tag_type IN ('QR','BARCODE','QR_BARCODE','NFC')),
  print_job_id BIGINT,
  replacement_of_id BIGINT REFERENCES asset_tags(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','PRINTED','ASSIGNED','DAMAGED','LOST','REPLACEMENT_PENDING','REPLACED','VOID','ARCHIVED')),
  generated_by BIGINT REFERENCES users(id),
  printed_at TIMESTAMPTZ,
  printed_by BIGINT REFERENCES users(id),
  attached_at TIMESTAMPTZ,
  attached_by BIGINT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  verified_by BIGINT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES users(id),
  void_reason TEXT,
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tag_no),
  UNIQUE (asset_id, qr_id)
);
CREATE INDEX idx_asset_tags_asset ON asset_tags(asset_id);
CREATE INDEX idx_asset_tags_qr ON asset_tags(qr_id);
CREATE INDEX idx_asset_tags_status ON asset_tags(status);

-- A voided tag can never be reactivated, and a replacement must always
-- reference the tag it supersedes (old tag records are never deleted).
CREATE OR REPLACE FUNCTION asset_tags_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'VOID' AND NEW.status <> 'VOID' THEN
    RAISE EXCEPTION 'A voided asset tag can never be reactivated';
  END IF;
  IF OLD.status = 'REPLACED' AND NEW.status <> 'REPLACED' THEN
    RAISE EXCEPTION 'A replaced asset tag cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_tags_status_guard ON asset_tags;
CREATE TRIGGER trg_asset_tags_status_guard
  BEFORE UPDATE OF status ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_tags_status_guard();

DROP TRIGGER IF EXISTS trg_asset_tags_no_delete ON asset_tags;
CREATE TRIGGER trg_asset_tags_no_delete
  BEFORE DELETE ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_register_no_delete();

CREATE TABLE asset_tag_print_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_no TEXT NOT NULL,
  template_id BIGINT REFERENCES label_templates(id),
  asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  quantity INTEGER NOT NULL DEFAULT 0,
  printer TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','PRINTING','PRINTED','FAILED','CANCELLED')),
  reprint_reason TEXT,
  requested_by BIGINT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_no)
);

CREATE TABLE asset_tag_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  tag_id BIGINT NOT NULL REFERENCES asset_tags(id),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('GENERATED','PRINTED','ATTACHED','VERIFIED','DAMAGED','LOST','REPLACEMENT_REQUESTED','REPLACED','VOIDED','ARCHIVED')),
  previous_status TEXT,
  new_status TEXT,
  reason TEXT,
  performed_by BIGINT REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_tag_events_tag ON asset_tag_events(tag_id);

-- ---------- 5. Asset scanning ----------
CREATE TABLE asset_scans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  qr_id BIGINT REFERENCES qr_codes(id),
  tag_id BIGINT REFERENCES asset_tags(id),
  scan_type TEXT NOT NULL DEFAULT 'IDENTIFY'
    CHECK (scan_type IN ('IDENTIFY','VERIFY','ASSIGN','TRANSFER','INSPECT','AUDIT','MAINTAIN','CHECKIN','CHECKOUT','REPORT_DAMAGE','REPORT_MISSING','DISPOSE','TRACK')),
  result TEXT NOT NULL DEFAULT 'AUTHENTIC'
    CHECK (result IN ('AUTHENTIC','VOID','SUSPICIOUS','UNKNOWN')),
  location_id BIGINT REFERENCES asset_locations(id),
  expected_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  device TEXT,
  scanned_by BIGINT REFERENCES users(id),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_asset_scans_asset ON asset_scans(asset_id);
CREATE INDEX idx_asset_scans_time ON asset_scans(scanned_at DESC);
CREATE INDEX idx_asset_scans_result ON asset_scans(result);

CREATE TABLE asset_scan_anomalies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT REFERENCES asset_register(id),
  scan_id BIGINT REFERENCES asset_scans(id),
  anomaly_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  description TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','REVIEWING','RESOLVED','DISMISSED')),
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_scan_anomalies_asset ON asset_scan_anomalies(asset_id);
CREATE INDEX idx_asset_scan_anomalies_status ON asset_scan_anomalies(status);

-- Anomaly detection: same asset scanned at incompatible locations in a short
-- window, rapid repeated scans, voided-tag scans, high-value unusual movement.
CREATE OR REPLACE FUNCTION detect_asset_scan_anomalies(
  p_asset_id bigint, p_scan_id bigint, p_location_id bigint
) RETURNS void AS $$
DECLARE
  v_rec record;
  v_prev record;
  v_high boolean;
  v_anomaly text;
  v_severity text := 'LOW';
  v_desc text;
BEGIN
  SELECT is_high_value INTO v_high FROM asset_register WHERE id = p_asset_id;

  -- Rapid repeated scans (< 5 seconds apart by the same user)
  SELECT a.id, a.scanned_by, a.scanned_at, a.location_id INTO v_prev
  FROM asset_scans a
  WHERE a.asset_id = p_asset_id AND a.id <> p_scan_id
  ORDER BY a.scanned_at DESC LIMIT 1;
  IF v_prev.id IS NOT NULL AND v_prev.scanned_by IS NOT DISTINCT FROM
     (SELECT scanned_by FROM asset_scans WHERE id = p_scan_id)
     AND v_prev.scanned_at > now() - interval '5 seconds' THEN
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description)
    SELECT company_id, tenant_id, asset_id, p_scan_id, 'RAPID_REPEATED_SCANS', 'MEDIUM',
           'Asset scanned repeatedly within 5 seconds'
    FROM asset_register WHERE id = p_asset_id;
  END IF;

  -- Same asset scanned at incompatible locations within 15 minutes
  IF p_location_id IS NOT NULL AND v_prev.location_id IS NOT NULL
     AND p_location_id <> v_prev.location_id
     AND v_prev.scanned_at > now() - interval '15 minutes' THEN
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description)
    SELECT company_id, tenant_id, asset_id, p_scan_id,
           CASE WHEN v_high THEN 'HIGH_VALUE_MOVED_UNUSUALLY' ELSE 'INCOMPATIBLE_LOCATION_SCANS' END,
           CASE WHEN v_high THEN 'HIGH' ELSE 'MEDIUM' END,
           'Asset scanned at incompatible locations within 15 minutes'
    FROM asset_register WHERE id = p_asset_id;
  END IF;

  -- Voided / replaced tag scanned
  FOR v_rec IN
    SELECT t.id AS tag_id, t.status FROM asset_tags t WHERE t.asset_id = p_asset_id AND t.status IN ('VOID','REPLACED')
  LOOP
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description, details)
    SELECT company_id, tenant_id, asset_id, p_scan_id, 'VOIDED_TAG_SCANNED', 'HIGH',
           'A voided or replaced asset tag was scanned', jsonb_build_object('tag_id', v_rec.tag_id, 'tag_status', v_rec.status)
    FROM asset_register WHERE id = p_asset_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ---------- 6. Custody ledger ----------
-- Every assignment, transfer and return writes a row here so custody is
-- fully traceable even after an asset is re-assigned.
CREATE TABLE asset_custody (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  custodian_user_id BIGINT REFERENCES users(id),
  custodian_employee_id BIGINT REFERENCES employees(id),
  custodian_department_id BIGINT REFERENCES departments(id),
  assignment_id BIGINT,
  transfer_id BIGINT,
  action TEXT NOT NULL DEFAULT 'ASSIGN'
    CHECK (action IN ('ASSIGN','TRANSFER','RETURN','REASSIGN','CHECKOUT','CHECKIN')),
  from_user_id BIGINT REFERENCES users(id),
  from_department_id BIGINT REFERENCES departments(id),
  assigned_date DATE,
  expected_return_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT true,
  accepted_at TIMESTAMPTZ,
  accepted_by BIGINT REFERENCES users(id),
  released_at TIMESTAMPTZ,
  reason TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_custody_asset ON asset_custody(asset_id);
CREATE INDEX idx_asset_custody_current ON asset_custody(asset_id) WHERE is_current = true;

-- ---------- 7. Asset transfers ----------
CREATE TABLE asset_transfers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  transfer_no TEXT NOT NULL,
  transfer_type TEXT NOT NULL DEFAULT 'LOCATION'
    CHECK (transfer_type IN ('EMPLOYEE','DEPARTMENT','BRANCH','WAREHOUSE','LOCATION','PROJECT')),
  from_location_id BIGINT REFERENCES asset_locations(id),
  to_location_id BIGINT REFERENCES asset_locations(id),
  from_department_id BIGINT REFERENCES departments(id),
  to_department_id BIGINT REFERENCES departments(id),
  from_branch_id BIGINT REFERENCES branches(id),
  to_branch_id BIGINT REFERENCES branches(id),
  from_user_id BIGINT REFERENCES users(id),
  to_user_id BIGINT REFERENCES users(id),
  reason TEXT,
  total_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  requires_dual_control BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PENDING_HANDOVER','COMPLETED','REJECTED','CANCELLED')),
  handover_at TIMESTAMPTZ,
  handover_by BIGINT REFERENCES users(id),
  recipient_confirmed_at TIMESTAMPTZ,
  recipient_confirmed_by BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, transfer_no)
);
CREATE INDEX idx_asset_transfers_status ON asset_transfers(status);

CREATE TABLE asset_transfer_items (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  transfer_id BIGINT NOT NULL REFERENCES asset_transfers(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  verified_at TIMESTAMPTZ,
  verified_by BIGINT REFERENCES users(id),
  UNIQUE (transfer_id, asset_id)
);
CREATE INDEX idx_asset_transfer_items_transfer ON asset_transfer_items(transfer_id);

-- ---------- 8. Asset audits ----------
CREATE TABLE asset_audits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  audit_no TEXT NOT NULL,
  audit_type TEXT NOT NULL
    CHECK (audit_type IN ('ANNUAL','QUARTERLY','MONTHLY','DEPARTMENT','BRANCH','SPOT','HIGH_VALUE')),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  location_id BIGINT REFERENCES asset_locations(id),
  department_id BIGINT REFERENCES departments(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SCHEDULED','IN_PROGRESS','PENDING_REVIEW','APPROVED','CLOSED','CANCELLED')),
  expected_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, audit_no)
);
CREATE INDEX idx_asset_audits_status ON asset_audits(status);

CREATE TABLE asset_audit_items (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  audit_id BIGINT NOT NULL REFERENCES asset_audits(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  expected_location_id BIGINT REFERENCES asset_locations(id),
  expected_custodian_user_id BIGINT REFERENCES users(id),
  actual_location_id BIGINT REFERENCES asset_locations(id),
  scanned_at TIMESTAMPTZ,
  scanned_by BIGINT REFERENCES users(id),
  result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (result IN ('PENDING','VERIFIED','NOT_FOUND','WRONG_LOCATION','WRONG_CUSTODIAN','DAMAGED','TAG_MISSING','TAG_DAMAGED','UNEXPECTED')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, asset_id)
);
CREATE INDEX idx_asset_audit_items_audit ON asset_audit_items(audit_id);
CREATE INDEX idx_asset_audit_items_result ON asset_audit_items(result);

CREATE TABLE asset_audit_exceptions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  audit_id BIGINT NOT NULL REFERENCES asset_audits(id) ON DELETE CASCADE,
  audit_item_id BIGINT REFERENCES asset_audit_items(id),
  asset_id BIGINT REFERENCES asset_register(id),
  exception_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  description TEXT,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','REVIEWING','RESOLVED','DISMISSED')),
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_audit_exceptions_audit ON asset_audit_exceptions(audit_id);

-- ---------- 9. Asset maintenance work orders ----------
CREATE TABLE asset_maintenance_work_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  wo_no TEXT NOT NULL,
  maintenance_type TEXT NOT NULL DEFAULT 'CORRECTIVE'
    CHECK (maintenance_type IN ('PREVENTIVE','CORRECTIVE','EMERGENCY','INSPECTION','CALIBRATION','SERVICE','REPAIR')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','CANCELLED')),
  technician_user_id BIGINT REFERENCES users(id),
  supplier_id BIGINT REFERENCES suppliers(id),
  scheduled_date DATE,
  completed_date DATE,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  downtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  parts_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  next_maintenance_date DATE,
  completed_by BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, wo_no)
);
CREATE INDEX idx_asset_mwo_asset ON asset_maintenance_work_orders(asset_id);
CREATE INDEX idx_asset_mwo_status ON asset_maintenance_work_orders(status);

-- Spare parts / consumables issued from Inventory during maintenance.
CREATE TABLE asset_maintenance_parts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT NOT NULL REFERENCES asset_maintenance_work_orders(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  reserved_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  issued_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  issued_at TIMESTAMPTZ,
  issued_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_maint_parts_wo ON asset_maintenance_parts(work_order_id);

-- ---------- 10. Warranties & insurance ----------
CREATE TABLE asset_warranties (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  provider TEXT NOT NULL,
  warranty_no TEXT,
  start_date DATE,
  end_date DATE,
  coverage TEXT,
  terms TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  claim_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_warranties_asset ON asset_warranties(asset_id);

CREATE TABLE asset_insurance (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  provider TEXT NOT NULL,
  policy_no TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  coverage TEXT,
  premium NUMERIC(18,2) NOT NULL DEFAULT 0,
  insured_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, policy_no)
);
CREATE INDEX idx_asset_insurance_asset ON asset_insurance(asset_id);

-- ---------- 11. Documents & photos ----------
CREATE TABLE asset_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  document_id BIGINT NOT NULL REFERENCES documents(id),
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('PURCHASE_INVOICE','PO','WARRANTY','MANUAL','CERTIFICATE','INSURANCE',
      'INSPECTION_CERTIFICATE','MAINTENANCE_REPORT','TRANSFER_FORM','ASSIGNMENT_FORM',
      'DISPOSAL_APPROVAL','PHOTO','OTHER')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, document_id)
);
CREATE INDEX idx_asset_documents_asset ON asset_documents(asset_id);

CREATE TABLE asset_photos (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  document_id BIGINT REFERENCES documents(id),
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('FRONT','BACK','SERIAL_NUMBER','QR_TAG','CONDITION','DAMAGE','LOCATION','OTHER')),
  storage_key TEXT,
  mime_type TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_photos_asset ON asset_photos(asset_id);

-- ---------- 12. Depreciation ----------
CREATE TABLE asset_depreciation (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE'
    CHECK (method IN ('STRAIGHT_LINE','REDUCING_BALANCE','UNITS_OF_PRODUCTION','CUSTOM','NONE')),
  useful_life_months INTEGER,
  residual_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  start_date DATE,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (frequency IN ('MONTHLY','QUARTERLY','ANNUAL')),
  last_posted_period DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id)
);
CREATE INDEX idx_asset_depreciation_asset ON asset_depreciation(asset_id);

CREATE TABLE asset_depreciation_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  accumulated_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0,
  book_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  posted_at TIMESTAMPTZ,
  posted_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period_start)
);
CREATE INDEX idx_asset_depr_entries_asset ON asset_depreciation_entries(asset_id);

-- ---------- 13. Impairment ----------
CREATE TABLE asset_impairments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  impairment_no TEXT NOT NULL,
  impairment_type TEXT NOT NULL DEFAULT 'IMPAIRMENT'
    CHECK (impairment_type IN ('IMPAIRMENT','REVERSAL','REVALUATION')),
  old_book_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  new_book_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','POSTED')),
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, impairment_no)
);
CREATE INDEX idx_asset_impairments_asset ON asset_impairments(asset_id);

-- ---------- 14. Disposal & retirement ----------
CREATE TABLE asset_disposals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  disposal_no TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'END_OF_USEFUL_LIFE'
    CHECK (reason IN ('OBSOLETE','DAMAGED','BEYOND_REPAIR','SOLD','LOST','STOLEN','REPLACEMENT',
      'END_OF_USEFUL_LIFE','OTHER')),
  method TEXT NOT NULL DEFAULT 'SCRAP'
    CHECK (method IN ('SALE','SCRAP','DONATION','RETURN_TO_SUPPLIER','WRITE_OFF','TRADE_IN')),
  valuation NUMERIC(18,2),
  sale_price NUMERIC(18,2),
  gain_loss NUMERIC(18,2),
  disposal_date DATE,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  requires_dual_control BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','VALUATION','INSPECTION','APPROVED','FINANCE_REVIEW',
      'COMPLETED','REJECTED','CANCELLED')),
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, disposal_no)
);
CREATE INDEX idx_asset_disposals_asset ON asset_disposals(asset_id);
CREATE INDEX idx_asset_disposals_status ON asset_disposals(status);

-- Configurable dual control for high-value disposals.
CREATE TABLE asset_disposal_approvals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  disposal_id BIGINT NOT NULL REFERENCES asset_disposals(id) ON DELETE CASCADE,
  approval_level INTEGER NOT NULL DEFAULT 1,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  decision TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (disposal_id, approval_level)
);

-- ---------- 15. Timeline, comments, import/export jobs ----------
CREATE TABLE asset_timeline (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  user_id BIGINT REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_value JSONB,
  new_value JSONB,
  location_id BIGINT REFERENCES asset_locations(id),
  reason TEXT,
  reference_doc_id BIGINT REFERENCES documents(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_asset_timeline_asset ON asset_timeline(asset_id, occurred_at DESC);

CREATE TABLE asset_comments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  asset_id BIGINT NOT NULL REFERENCES asset_register(id),
  body TEXT NOT NULL,
  parent_id BIGINT REFERENCES asset_comments(id),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_comments_asset ON asset_comments(asset_id);

CREATE TABLE asset_import_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_no TEXT NOT NULL,
  file_name TEXT,
  format TEXT NOT NULL DEFAULT 'CSV'
    CHECK (format IN ('CSV','XLSX','JSON')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING','COMPLETED','FAILED','CANCELLED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_no)
);

CREATE TABLE asset_export_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_no TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'PDF'
    CHECK (format IN ('PDF','XLSX','CSV','JSON')),
  report_type TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_key TEXT,
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING','COMPLETED','FAILED','CANCELLED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_no)
);

-- ---------- 16. Updated-at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('asset_types','asset_classes','asset_statuses','asset_conditions',
        'asset_locations','asset_sequence_rules','asset_register','asset_tags',
        'asset_tag_print_jobs','asset_scan_anomalies','asset_custody','asset_transfers',
        'asset_audits','asset_audit_items','asset_audit_exceptions',
        'asset_maintenance_work_orders','asset_maintenance_parts','asset_warranties',
        'asset_insurance','asset_depreciation','asset_impairments','asset_disposals',
        'asset_comments','asset_import_jobs','asset_export_jobs')
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

-- ---------- 17. DB-level audit triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'asset_types','asset_classes','asset_statuses','asset_conditions','asset_locations',
    'asset_sequence_rules','asset_register','asset_tags','asset_tag_print_jobs',
    'asset_tag_events','asset_scans','asset_scan_anomalies','asset_custody',
    'asset_transfers','asset_transfer_items','asset_audits','asset_audit_items',
    'asset_audit_exceptions','asset_maintenance_work_orders','asset_maintenance_parts',
    'asset_warranties','asset_insurance','asset_documents','asset_photos',
    'asset_depreciation','asset_depreciation_entries','asset_impairments',
    'asset_disposals','asset_disposal_approvals','asset_timeline','asset_comments',
    'asset_import_jobs','asset_export_jobs'
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

-- ---------- 18. Row-level security: tenant isolation ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'asset_types','asset_classes','asset_statuses','asset_conditions','asset_locations',
    'asset_sequence_rules','asset_register','asset_tags','asset_tag_print_jobs',
    'asset_tag_events','asset_scans','asset_scan_anomalies','asset_custody',
    'asset_transfers','asset_transfer_items','asset_audits','asset_audit_items',
    'asset_audit_exceptions','asset_maintenance_work_orders','asset_maintenance_parts',
    'asset_warranties','asset_insurance','asset_documents','asset_photos',
    'asset_depreciation','asset_depreciation_entries','asset_impairments',
    'asset_disposals','asset_disposal_approvals','asset_timeline','asset_comments',
    'asset_import_jobs','asset_export_jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public'
        AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 19. Module activation ----------
-- An EMPTY activate_modules array means "all modules are available" (see
-- apps/web/src/nav.ts moduleActiveForTenant). Appending 'assets' to an empty
-- list would turn the whitelist on and hide every other module (finance, HR,
-- sales, procurement, inventory, etc.), so this is intentionally a no-op:
-- the assets module ships active for the HDG tenant without restricting the
-- rest of the ERP.
