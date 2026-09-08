-- ============================================================================
-- 0135 - Hikvision Biometric Attendance & Access Control Integration
-- DS-K1T-series terminals: raw event capture, secure ingest, normalization,
-- attendance processing engine, exceptions, device health, RBAC/ABAC audit.
-- Idempotent: safe on fresh + existing DB. All tables are tenant scoped.
-- ============================================================================

-- ============================================================================
-- 1. Devices
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  serial_number TEXT NOT NULL,
  ip_address TEXT,
  mac_address TEXT,
  facility TEXT,
  physical_location TEXT,
  device_purpose TEXT NOT NULL DEFAULT 'ATTENDANCE' CHECK (device_purpose IN (
    'ENTRY','EXIT','ATTENDANCE','BREAK_ENTRY','BREAK_EXIT',
    'PRODUCTION','WAREHOUSE','SECURE_AREA'
  )),
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  firmware_version TEXT,
  isapi_enabled BOOLEAN NOT NULL DEFAULT true,
  isapi_username TEXT,
  isapi_encrypted_password TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  connection_status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (connection_status IN (
    'ONLINE','OFFLINE','WARNING','MAINTENANCE','DISABLED'
  )),
  status_reason TEXT,
  auth_key_hash TEXT NOT NULL DEFAULT '',
  auth_key_prefix TEXT NOT NULL DEFAULT '',
  ip_allowlist TEXT[] NOT NULL DEFAULT '{}',
  allow_query_key BOOLEAN NOT NULL DEFAULT false,
  timestamp_skew_seconds INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  last_clock_drift_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_hikvision_devices_tenant_company ON hikvision_devices(tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_hikvision_devices_purpose ON hikvision_devices(company_id, device_purpose);
CREATE INDEX IF NOT EXISTS idx_hikvision_devices_status ON hikvision_devices(company_id, connection_status);

-- ============================================================================
-- 2. Device locations (registry of physical placements per facility)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_device_locations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  device_id BIGINT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  facility TEXT NOT NULL,
  physical_location TEXT NOT NULL,
  zone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_loc_device ON hikvision_device_locations(device_id, is_active);
-- ============================================================================
-- 3. Device configurations (operational behaviour per terminal)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_device_configurations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  attendance_enabled BOOLEAN NOT NULL DEFAULT true,
  access_events_enabled BOOLEAN NOT NULL DEFAULT true,
  duplicate_window_seconds INTEGER NOT NULL DEFAULT 30,
  replay_window_seconds INTEGER NOT NULL DEFAULT 60,
  allow_future_minutes INTEGER NOT NULL DEFAULT 5,
  allow_past_minutes INTEGER NOT NULL DEFAULT 1440,
  break_start TEXT,
  break_end TEXT,
  default_shift_code TEXT,
  notify_device_offline BOOLEAN NOT NULL DEFAULT true,
  notify_device_online BOOLEAN NOT NULL DEFAULT false,
  notify_clock_drift BOOLEAN NOT NULL DEFAULT true,
  notify_unknown_employee BOOLEAN NOT NULL DEFAULT true,
  notify_integration_failure BOOLEAN NOT NULL DEFAULT true,
  clock_drift_warning_seconds INTEGER NOT NULL DEFAULT 120,
  heartbeat_stale_seconds INTEGER NOT NULL DEFAULT 300,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 60,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_hikvision_cfg_device ON hikvision_device_configurations(device_id);

-- ============================================================================
-- 4. Raw events - append-only receipt journal. Every event is preserved first.
--    Never delete raw rows; duplicates and rejects are marked, not removed.
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_raw_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT REFERENCES hikvision_devices(id),
  device_serial_number TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_format TEXT NOT NULL DEFAULT 'JSON' CHECK (payload_format IN ('JSON','XML','FORM','UNKNOWN')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_event_time TIMESTAMPTZ,
  event_type TEXT,
  source_ip TEXT,
  source_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT,
  duplicate_of_raw_event_id BIGINT REFERENCES hikvision_raw_events(id),
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN (
    'RECEIVED','QUEUED','PROCESSING','PROCESSED','DUPLICATE','FAILED','REJECTED'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hikvision_raw_dedupe
  ON hikvision_raw_events(device_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hikvision_raw_queue
  ON hikvision_raw_events(processing_status, created_at) WHERE processing_status IN ('RECEIVED','QUEUED','PROCESSING');
CREATE INDEX IF NOT EXISTS idx_hikvision_raw_device_time
  ON hikvision_raw_events(tenant_id, device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_hikvision_raw_dup
  ON hikvision_raw_events(duplicate_of_raw_event_id) WHERE duplicate_of_raw_event_id IS NOT NULL;

-- ============================================================================
-- 5. Normalized events - canonical AttendanceEvent model after normalization
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_normalized_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  raw_event_id BIGINT NOT NULL REFERENCES hikvision_raw_events(id) ON DELETE CASCADE,
  device_id BIGINT REFERENCES hikvision_devices(id),
  event_id TEXT,
  employee_identifier TEXT,
  employee_id BIGINT REFERENCES employees(id),
  event_time TIMESTAMPTZ NOT NULL,
  received_time TIMESTAMPTZ NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (verification_method IN (
    'FACE','CARD','FINGERPRINT','PASSWORD','QR','UNKNOWN'
  )),
  event_type TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (event_type IN (
    'CHECK_IN','CHECK_OUT','BREAK_START','BREAK_END',
    'ACCESS_GRANTED','ACCESS_DENIED','UNKNOWN'
  )),
  location TEXT,
  classification_reason TEXT,
  attendance_punch_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (raw_event_id)
);
CREATE INDEX IF NOT EXISTS idx_hikvision_norm_device_time ON hikvision_normalized_events(tenant_id, device_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_hikvision_norm_employee_time ON hikvision_normalized_events(tenant_id, employee_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_hikvision_norm_emp_identifier ON hikvision_normalized_events(tenant_id, employee_identifier);
-- ============================================================================
-- 6. Employee synchronization log (ERP -> Hikvision actions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT REFERENCES hikvision_devices(id),
  employee_id BIGINT REFERENCES employees(id),
  action TEXT NOT NULL CHECK (action IN (
    'SYNC_EMPLOYEE','SYNC_SELECTED','BULK_SYNC','DEACTIVATE_EMPLOYEE',
    'DISABLE_ACCESS','REMOVE_DEVICE_ACCESS','TIME_SYNC'
  )),
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','PARTIAL','FAILED','SKIPPED')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  performed_by BIGINT REFERENCES users(id),
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_sync_emp ON hikvision_sync_logs(tenant_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hikvision_sync_device ON hikvision_sync_logs(tenant_id, device_id, created_at DESC);

-- ============================================================================
-- 7. Explicit ERP <-> Hikvision employee number mapping (optional override)
--    The default identity resolution is employees.employee_no, then
--    employee_identities (RFID_IDENTITY / BIOMETRIC_REFERENCE / SHORT_BADGE_ID).
--    An explicit link always wins when present. Employees are NEVER
--    auto-created for unknown identifiers.
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_employee_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id BIGINT REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  employee_identifier TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hikvision_emp_link
  ON hikvision_employee_links(company_id, employee_identifier, COALESCE(device_id, 0));
CREATE INDEX IF NOT EXISTS idx_hikvision_emp_link_employee ON hikvision_employee_links(tenant_id, employee_id);

-- ============================================================================
-- 8. Integration errors (processing failures, transport errors, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_integration_errors (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  device_id BIGINT REFERENCES hikvision_devices(id),
  raw_event_id BIGINT REFERENCES hikvision_raw_events(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  stack TEXT,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_ierr_device ON hikvision_integration_errors(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hikvision_ierr_unresolved ON hikvision_integration_errors(tenant_id, resolved, created_at DESC);

-- ============================================================================
-- 9. Device heartbeats (append-only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_device_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_time TIMESTAMPTZ,
  clock_drift_seconds INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  firmware_version TEXT,
  network JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_hb_device ON hikvision_device_heartbeats(tenant_id, device_id, heartbeat_at DESC);

-- ============================================================================
-- 10. Device health log (status transitions, events, failures)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_device_health_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  health_type TEXT NOT NULL CHECK (health_type IN (
    'STATUS_CHANGE','HEARTBEAT','EVENT','CLOCK_DRIFT','ERROR','SYNC','MAINTENANCE'
  )),
  previous_status TEXT,
  new_status TEXT,
  message TEXT,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_health_device ON hikvision_device_health_logs(tenant_id, device_id, created_at DESC);

-- ============================================================================
-- 11. Clock drift log (append-only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_clock_drift_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id BIGINT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  device_time TIMESTAMPTZ,
  server_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  drift_seconds INTEGER NOT NULL,
  drift_abs_seconds INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OK','WARNING','CRITICAL')),
  synced BOOLEAN NOT NULL DEFAULT false,
  synced_by BIGINT REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hikvision_drift_device ON hikvision_clock_drift_logs(tenant_id, device_id, created_at DESC);
-- ============================================================================
-- 12. Attendance periods (approval + payroll lock workflow)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_periods (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  period_code TEXT NOT NULL,
  period_name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','PENDING_APPROVAL','APPROVED','LOCKED'
  )),
  locked_by BIGINT REFERENCES users(id),
  locked_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_code),
  UNIQUE (company_id, branch_id, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_periods_status ON attendance_periods(company_id, status, end_date DESC);

-- ============================================================================
-- 13. Attendance records (calculated, per employee per day per shift)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  period_id BIGINT REFERENCES attendance_periods(id),
  shift_id BIGINT REFERENCES shifts(id),
  shift_code TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  break_start TIMESTAMPTZ,
  break_end TIMESTAMPTZ,
  scheduled_minutes INTEGER NOT NULL DEFAULT 0,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  early_departure_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  undertime_minutes INTEGER NOT NULL DEFAULT 0,
  attendance_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (attendance_status IN (
    'PRESENT','ABSENT','LATE','EARLY_DEPARTURE','ON_LEAVE','HOLIDAY','HALF_DAY','PENDING','EXCUSED'
  )),
  approval_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (approval_status IN (
    'DRAFT','SUBMITTED','APPROVED','REJECTED','ADJUSTED'
  )),
  source TEXT NOT NULL DEFAULT 'HIKVISION',
  raw_punch_count INTEGER NOT NULL DEFAULT 0,
  segment_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_records_emp_date_shift
  ON attendance_records(company_id, employee_id, work_date, COALESCE(shift_id, 0));
CREATE INDEX IF NOT EXISTS idx_attendance_records_emp_date ON attendance_records(tenant_id, employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_records_period ON attendance_records(period_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_status ON attendance_records(company_id, work_date, attendance_status);
CREATE INDEX IF NOT EXISTS idx_attendance_records_dept_date ON attendance_records(company_id, department_id, work_date);

-- ============================================================================
-- 14. Attendance punch events (raw classified punches, one row per punch)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_punch_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_record_id BIGINT REFERENCES attendance_records(id) ON DELETE CASCADE,
  device_id BIGINT REFERENCES hikvision_devices(id),
  raw_event_id BIGINT UNIQUE REFERENCES hikvision_raw_events(id),
  punch_time TIMESTAMPTZ NOT NULL,
  punch_type TEXT NOT NULL CHECK (punch_type IN (
    'CHECK_IN','CHECK_OUT','BREAK_START','BREAK_END',
    'ACCESS_GRANTED','ACCESS_DENIED','UNKNOWN'
  )),
  verification_method TEXT NOT NULL DEFAULT 'UNKNOWN',
  device_purpose TEXT,
  location TEXT,
  segment TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_punch_emp_time ON attendance_punch_events(tenant_id, employee_id, punch_time DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_punch_record ON attendance_punch_events(attendance_record_id);
CREATE INDEX IF NOT EXISTS idx_attendance_punch_device ON attendance_punch_events(device_id, punch_time DESC);
-- ============================================================================
-- 15. Attendance exceptions centre
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_exceptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  employee_id BIGINT REFERENCES employees(id) ON DELETE CASCADE,
  device_id BIGINT REFERENCES hikvision_devices(id),
  raw_event_id BIGINT REFERENCES hikvision_raw_events(id) ON DELETE CASCADE,
  attendance_record_id BIGINT REFERENCES attendance_records(id) ON DELETE CASCADE,
  exception_type TEXT NOT NULL CHECK (exception_type IN (
    'UNKNOWN_EMPLOYEE','UNMAPPED_DEVICE','DUPLICATE_PUNCH','MISSING_CHECK_IN',
    'MISSING_CHECK_OUT','LATE_ARRIVAL','EARLY_DEPARTURE','DEVICE_OFFLINE',
    'INVALID_TIMESTAMP','REPLAY_EVENT','SHIFT_CONFLICT','PERIOD_LOCKED','OTHER'
  )),
  severity TEXT NOT NULL DEFAULT 'WARN' CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','ASSIGNED','REVIEWING','RESOLVED','APPROVED','REJECTED'
  )),
  employee_identifier TEXT,
  event_time TIMESTAMPTZ,
  summary TEXT,
  resolution TEXT,
  assigned_to BIGINT REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_exc_status ON attendance_exceptions(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_exc_type ON attendance_exceptions(company_id, exception_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_exc_emp ON attendance_exceptions(tenant_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_exc_raw ON attendance_exceptions(raw_event_id);

-- ============================================================================
-- 16. Manual attendance adjustments (always audited)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_adjustments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_record_id BIGINT REFERENCES attendance_records(id) ON DELETE CASCADE,
  exception_id BIGINT REFERENCES attendance_exceptions(id) ON DELETE SET NULL,
  adjustment_type TEXT NOT NULL,
  previous_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_adjust_record ON attendance_adjustments(attendance_record_id);
CREATE INDEX IF NOT EXISTS idx_attendance_adjust_status ON attendance_adjustments(company_id, status, created_at DESC);

-- ============================================================================
-- 17. Period lock history (payroll hand-off control)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_period_locks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  period_id BIGINT NOT NULL REFERENCES attendance_periods(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('SUBMIT','APPROVE','LOCK','UNLOCK','REJECT')),
  from_status TEXT,
  to_status TEXT,
  performed_by BIGINT NOT NULL REFERENCES users(id),
  ip_address TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_period_lock_period ON attendance_period_locks(period_id);

-- ============================================================================
-- 18. Daily reconciliation sweeps (missing punches, absentees, notifications)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hikvision_daily_sweeps (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  sweep_date DATE NOT NULL,
  sweep_type TEXT NOT NULL DEFAULT 'RECONCILE' CHECK (sweep_type IN (
    'RECONCILE','MISSING_PUNCH','ABSENTEE','PERIOD_CLOSE','DEVICE_HEALTH'
  )),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','PARTIAL')),
  total_records INTEGER NOT NULL DEFAULT 0,
  affected_records INTEGER NOT NULL DEFAULT 0,
  exceptions_created INTEGER NOT NULL DEFAULT 0,
  notifications_sent INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, sweep_date, sweep_type)
);
CREATE INDEX IF NOT EXISTS idx_hikvision_sweep_date ON hikvision_daily_sweeps(company_id, sweep_date DESC);
-- ============================================================================
-- 19. RLS + triggers. Standard tables enforce tenant isolation for the
--     least-privilege runtime role (hopedesign_app). Queue/log tables are
--     RLS-enabled (not FORCED) so owner-context background workers and the
--     SECURITY DEFINER helpers below operate across tenants.
-- ============================================================================
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hikvision_devices','hikvision_device_locations','hikvision_device_configurations',
    'hikvision_raw_events','hikvision_normalized_events','hikvision_sync_logs',
    'hikvision_integration_errors','hikvision_employee_links','hikvision_device_heartbeats',
    'hikvision_device_health_logs','hikvision_clock_drift_logs','attendance_periods',
    'attendance_records','attendance_punch_events','attendance_exceptions',
    'attendance_adjustments','attendance_period_locks','hikvision_daily_sweeps'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

-- updated_at maintenance on mutable tables
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hikvision_devices','hikvision_device_locations','hikvision_device_configurations',
    'hikvision_raw_events','hikvision_employee_links','attendance_periods',
    'attendance_records','attendance_exceptions','attendance_adjustments'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- Row-level audit for governance tables (hikvision_devices is intentionally
-- excluded: auth_key_hash must never be persisted in the row-level audit log).
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hikvision_device_configurations','hikvision_employee_links','hikvision_sync_logs',
    'attendance_records','attendance_periods','attendance_exceptions','attendance_adjustments'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 20. SECURITY DEFINER bridge helpers. The webhook authenticates a device by
--     serial + shared key and the background queue poll claims raw events
--     across tenants without an authenticated end-user context.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.hikvision_auth_device(p_serial_number TEXT, p_key TEXT, p_ip TEXT DEFAULT NULL)
RETURNS TABLE (
  id BIGINT, tenant_id BIGINT, company_id BIGINT, branch_id BIGINT, department_id BIGINT,
  code TEXT, name TEXT, model TEXT, serial_number TEXT, device_purpose TEXT,
  timezone TEXT, enabled BOOLEAN, connection_status TEXT, allow_query_key BOOLEAN,
  duplicate_window_seconds INTEGER, replay_window_seconds INTEGER,
  allow_future_minutes INTEGER, allow_past_minutes INTEGER,
  attendance_enabled BOOLEAN, access_events_enabled BOOLEAN,
  break_start TEXT, break_end TEXT, default_shift_code TEXT,
  clock_drift_warning_seconds INTEGER, heartbeat_stale_seconds INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_key_hash TEXT;
  v_dev hikvision_devices%ROWTYPE;
  v_cfg hikvision_device_configurations%ROWTYPE;
BEGIN
  v_key_hash := encode(sha256(COALESCE(p_key, '')::bytea), 'hex');
  SELECT * INTO v_dev FROM hikvision_devices hd
   WHERE hd.serial_number = p_serial_number
     AND hd.auth_key_hash = v_key_hash
     AND hd.auth_key_hash <> ''
     AND hd.enabled = true
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_INVALID_DEVICE_CREDENTIALS';
  END IF;
  IF p_ip IS NOT NULL AND p_ip <> '' AND cardinality(v_dev.ip_allowlist) > 0
     AND NOT (p_ip = ANY (v_dev.ip_allowlist)) THEN
    RAISE EXCEPTION 'ERR_SOURCE_NOT_ALLOWED';
  END IF;
  SELECT * INTO v_cfg FROM hikvision_device_configurations c
   WHERE c.device_id = v_dev.id ORDER BY c.id DESC LIMIT 1;
  IF NOT FOUND THEN
    v_cfg.duplicate_window_seconds := 30;
    v_cfg.replay_window_seconds := 60;
    v_cfg.allow_future_minutes := 5;
    v_cfg.allow_past_minutes := 1440;
    v_cfg.attendance_enabled := true;
    v_cfg.access_events_enabled := true;
    v_cfg.clock_drift_warning_seconds := 120;
    v_cfg.heartbeat_stale_seconds := 300;
  END IF;
  id := v_dev.id;
  tenant_id := v_dev.tenant_id;
  company_id := v_dev.company_id;
  branch_id := v_dev.branch_id;
  department_id := v_dev.department_id;
  code := v_dev.code;
  name := v_dev.name;
  model := v_dev.model;
  serial_number := v_dev.serial_number;
  device_purpose := v_dev.device_purpose;
  timezone := v_dev.timezone;
  enabled := v_dev.enabled;
  connection_status := v_dev.connection_status;
  allow_query_key := v_dev.allow_query_key;
  duplicate_window_seconds := v_cfg.duplicate_window_seconds;
  replay_window_seconds := v_cfg.replay_window_seconds;
  allow_future_minutes := v_cfg.allow_future_minutes;
  allow_past_minutes := v_cfg.allow_past_minutes;
  attendance_enabled := v_cfg.attendance_enabled;
  access_events_enabled := v_cfg.access_events_enabled;
  break_start := v_cfg.break_start;
  break_end := v_cfg.break_end;
  default_shift_code := v_cfg.default_shift_code;
  clock_drift_warning_seconds := v_cfg.clock_drift_warning_seconds;
  heartbeat_stale_seconds := v_cfg.heartbeat_stale_seconds;
  RETURN NEXT;
END;
$fn$;

-- Claim a batch of queued raw events for processing (marks them PROCESSING).
-- Re-queues stale PROCESSING rows older than p_stale_seconds first.
CREATE OR REPLACE FUNCTION public.hikvision_claim_raw_events(p_batch INTEGER DEFAULT 50, p_stale_seconds INTEGER DEFAULT 300)
RETURNS TABLE (
  id BIGINT, tenant_id BIGINT, company_id BIGINT, branch_id BIGINT, department_id BIGINT,
  device_id BIGINT, device_serial_number TEXT, raw_event_id BIGINT,
  payload JSONB, payload_format TEXT, device_event_time TIMESTAMPTZ, event_type TEXT,
  source_ip TEXT, retry_count INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE hikvision_raw_events
     SET processing_status = 'QUEUED', error_message = NULL,
         updated_at = now()
   WHERE processing_status = 'PROCESSING'
     AND updated_at < now() - make_interval(secs => p_stale_seconds);
  FOR id, tenant_id, company_id, branch_id, department_id, device_id, device_serial_number,
      raw_event_id, payload, payload_format, device_event_time, event_type, source_ip, retry_count IN
    SELECT r.id, r.tenant_id, r.company_id, d.branch_id, d.department_id, r.device_id,
           r.device_serial_number, r.id, r.payload, r.payload_format, r.device_event_time,
           r.event_type, r.source_ip, r.retry_count
      FROM hikvision_raw_events r
      LEFT JOIN hikvision_devices d ON d.id = r.device_id
     WHERE r.processing_status IN ('RECEIVED','QUEUED')
       AND r.duplicate_of_raw_event_id IS NULL
     ORDER BY r.created_at
     LIMIT p_batch
     FOR UPDATE OF r SKIP LOCKED
  LOOP
    UPDATE hikvision_raw_events
       SET processing_status = 'PROCESSING', updated_at = now()
     WHERE hikvision_raw_events.id = raw_event_id;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.hikvision_auth_device(TEXT, TEXT, TEXT) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.hikvision_claim_raw_events(INTEGER, INTEGER) TO hopedesign_app;
-- ============================================================================
-- 21. Permissions (modules: hikvision + hr.attendance workflow actions)
-- ============================================================================
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('hikvision.command.view','hikvision','command','view','View the Hikvision integration command centre'),
  ('hikvision.dashboard.view','hikvision','dashboard','view','View the Hikvision live attendance dashboard'),
  ('hikvision.devices.view','hikvision','devices','view','View Hikvision devices'),
  ('hikvision.devices.create','hikvision','devices','create','Register Hikvision devices'),
  ('hikvision.devices.update','hikvision','devices','update','Update Hikvision devices'),
  ('hikvision.devices.delete','hikvision','devices','delete','Delete Hikvision devices'),
  ('hikvision.events.view','hikvision','events','view','View raw and normalized Hikvision events'),
  ('hikvision.events.retry','hikvision','events','retry','Retry failed Hikvision events'),
  ('hikvision.events.reprocess','hikvision','events','reprocess','Reprocess Hikvision events'),
  ('hikvision.events.reject','hikvision','events','reject','Reject Hikvision events'),
  ('hikvision.exceptions.view','hikvision','exceptions','view','View attendance exceptions'),
  ('hikvision.exceptions.assign','hikvision','exceptions','assign','Assign attendance exceptions'),
  ('hikvision.exceptions.resolve','hikvision','exceptions','resolve','Resolve attendance exceptions'),
  ('hikvision.exceptions.approve','hikvision','exceptions','approve','Approve attendance exceptions'),
  ('hikvision.exceptions.reject','hikvision','exceptions','reject','Reject attendance exceptions'),
  ('hikvision.sync.view','hikvision','sync','view','View employee synchronization logs'),
  ('hikvision.sync.employee','hikvision','sync','employee','Synchronize a single employee to Hikvision devices'),
  ('hikvision.sync.bulk','hikvision','sync','bulk','Bulk synchronize employees to Hikvision devices'),
  ('hikvision.sync.remove_access','hikvision','sync','remove_access','Remove employee access on Hikvision devices'),
  ('hikvision.configuration.view','hikvision','configuration','view','View Hikvision integration configuration'),
  ('hikvision.configuration.manage','hikvision','configuration','manage','Manage Hikvision integration configuration'),
  ('hikvision.health.view','hikvision','health','view','View Hikvision device health'),
  ('hikvision.reports.view','hikvision','reports','view','View Hikvision attendance and device reports'),
  ('hikvision.reports.export','hikvision','reports','export','Export Hikvision attendance and device reports'),
  ('hikvision.employee_links.view','hikvision','employee_links','view','View ERP to Hikvision employee links'),
  ('hikvision.employee_links.create','hikvision','employee_links','create','Create ERP to Hikvision employee links'),
  ('hikvision.employee_links.update','hikvision','employee_links','update','Update ERP to Hikvision employee links'),
  ('hikvision.employee_links.delete','hikvision','employee_links','delete','Delete ERP to Hikvision employee links'),
  ('hr.attendance.review','hr','attendance','review','Review attendance records'),
  ('hr.attendance.approve','hr','attendance','approve','Approve attendance records and periods'),
  ('hr.attendance.reject','hr','attendance','reject','Reject attendance records and periods'),
  ('hr.attendance.create_adjustment','hr','attendance','create_adjustment','Create manual attendance adjustments'),
  ('hr.attendance.lock','hr','attendance','lock','Lock attendance periods for payroll'),
  ('hr.attendance.view_own','hr','attendance','view_own','View own attendance records')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Full administration + HR scopes
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'hikvision.%'
WHERE r.code IN (
  'super_administrator','system_administrator','security_administrator',
  'integration_administrator','hr_director','hr_manager','time_attendance_officer'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- HR officer: operational scopes excluding destructive/sync-time actions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'hikvision.command.view','hikvision.dashboard.view','hikvision.devices.view',
  'hikvision.events.view','hikvision.exceptions.view','hikvision.exceptions.assign',
  'hikvision.exceptions.resolve','hikvision.sync.view','hikvision.configuration.view',
  'hikvision.health.view','hikvision.reports.view','hikvision.employee_links.view'
)
WHERE r.code = 'hr_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- HR assistant: read + exception support
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'hikvision.dashboard.view','hikvision.devices.view','hikvision.events.view',
  'hikvision.exceptions.view','hikvision.health.view','hikvision.sync.view'
)
WHERE r.code = 'hr_assistant'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Attendance approval workflow grants for HR roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'hr.attendance.review','hr.attendance.approve','hr.attendance.reject',
  'hr.attendance.create_adjustment','hr.attendance.lock','hr.attendance.view_own'
)
WHERE r.code IN ('hr_director','hr_manager','time_attendance_officer','hr_officer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Employee self-service: own attendance only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.attendance.view_own','hr.attendance.view')
WHERE r.code = 'employee_self_service'
ON CONFLICT (role_id, permission_id) DO NOTHING;