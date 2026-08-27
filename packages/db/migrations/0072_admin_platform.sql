-- 0072_admin_platform.sql
-- Users, Identity, Access Control, Administration, Security and Platform
-- Management control plane for HOPE DESIGN GROUP LTD Enterprise ERP.

-- ---------- 1. Extend audit_row() secret stripping to all tables ----------
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE
  v_tenant bigint; v_company bigint; v_branch bigint;
  v_changes jsonb; v_code text;
  v_old jsonb; v_new jsonb; v_row jsonb; k text;
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  -- Never persist secrets in audit payloads (applies to every table).
  FOREACH k IN ARRAY ARRAY['password_hash','mfa_secret','token_hash','key_hash','code_hash','secret_hash','fingerprint_hash','backup_code_hash'] LOOP
    v_old := v_old - k;
    v_new := v_new - k;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    v_tenant := NULLIF(v_old->>'tenant_id','')::bigint;
    v_company := NULLIF(v_old->>'company_id','')::bigint;
    v_branch := NULLIF(v_old->>'branch_id','')::bigint;
    v_changes := v_old;
    v_row := v_old;
  ELSE
    v_tenant := NULLIF(v_new->>'tenant_id','')::bigint;
    v_company := NULLIF(v_new->>'company_id','')::bigint;
    v_branch := NULLIF(v_new->>'branch_id','')::bigint;
    v_row := v_new;
    IF TG_OP = 'INSERT' THEN
      v_changes := v_new;
    ELSE
      v_changes := jsonb_diff(v_old, v_new);
    END IF;
  END IF;

  v_code := COALESCE(
    NULLIF(v_row->>'code',''), NULLIF(v_row->>'document_no',''),
    NULLIF(v_row->>'doc_no',''), NULLIF(v_row->>'entry_no',''),
    NULLIF(v_row->>'wo_no',''), NULLIF(v_row->>'order_no',''),
    NULLIF(v_row->>'po_no',''), NULLIF(v_row->>'job_no',''),
    NULLIF(v_row->>'invoice_no',''), NULLIF(v_row->>'grn_no',''),
    NULLIF(v_row->>'quote_no',''), NULLIF(v_row->>'quotation_no',''),
    NULLIF(v_row->>'transfer_no',''), NULLIF(v_row->>'adjustment_no',''),
    NULLIF(v_row->>'payment_no',''), NULLIF(v_row->>'receipt_no',''),
    NULLIF(v_row->>'ncr_no',''), NULLIF(v_row->>'capa_no',''),
    NULLIF(v_row->>'return_no',''), NULLIF(v_row->>'contract_no',''),
    NULLIF(v_row->>'pr_no',''), NULLIF(v_row->>'rfq_no',''),
    NULLIF(v_row->>'delivery_no',''), NULLIF(v_row->>'credit_no',''),
    NULLIF(v_row->>'complaint_no',''), NULLIF(v_row->>'lead_no',''),
    NULLIF(v_row->>'mwo_no',''), NULLIF(v_row->>'request_no',''),
    NULLIF(v_row->>'trip_no',''), NULLIF(v_row->>'payroll_no',''),
    NULLIF(v_row->>'employee_no',''), NULLIF(v_row->>'label_no',''),
    NULLIF(v_row->>'plan_no',''), NULLIF(v_row->>'inspection_no',''),
    NULLIF(v_row->>'email',''), NULLIF(v_row->>'username',''),
    (v_row->>'id')::text
  );

  INSERT INTO audit_logs (tenant_id, company_id, branch_id, user_id, correlation_id, action, resource, record_id, record_code, old_values, new_values, changes, ip, user_agent, device, metadata)
  VALUES (
    v_tenant, v_company, v_branch, app_user_id(), current_setting('app.correlation_id', true),
    lower(TG_OP), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), v_code,
    CASE WHEN TG_OP = 'UPDATE' THEN v_old ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN v_new ELSE NULL END,
    v_changes,
    current_setting('app.ip', true), current_setting('app.user_agent', true), current_setting('app.device', true),
    jsonb_build_object('table', TG_TABLE_NAME)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. Identity and access tables ----------
CREATE TABLE IF NOT EXISTS user_invitations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  role_id BIGINT REFERENCES roles(id),
  invited_by BIGINT REFERENCES users(id),
  message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_invitations_tenant ON user_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_invitations_status ON user_invitations(status);
CREATE INDEX IF NOT EXISTS idx_user_invitations_user ON user_invitations(user_id);

CREATE TABLE IF NOT EXISTS user_status_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_status_history_user ON user_status_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_status_history_created ON user_status_history(created_at);

CREATE TABLE IF NOT EXISTS user_permissions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by BIGINT REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_user_permissions_tenant ON user_permissions(tenant_id);

CREATE TABLE IF NOT EXISTS permission_overrides (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  granted_by BIGINT REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_permission_overrides_tenant ON permission_overrides(tenant_id);

CREATE TABLE IF NOT EXISTS policy_conditions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  policy_id BIGINT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  attribute_type TEXT NOT NULL CHECK (attribute_type IN ('SUBJECT','RESOURCE','ENVIRONMENT')),
  attribute TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('EQUALS','NOT_EQUALS','IN','NOT_IN','GREATER_THAN','LESS_THAN','BETWEEN','EXISTS','NOT_EXISTS')),
  value jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_conditions_policy ON policy_conditions(policy_id);

CREATE TABLE IF NOT EXISTS organization_scopes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  warehouse_id BIGINT,
  facility_id BIGINT,
  project_id BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS user_scopes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('COMPANY','BRANCH','DEPARTMENT','COST_CENTRE','PROFIT_CENTRE','WAREHOUSE','FACILITY','PROJECT','ORGANIZATION')),
  scope_id BIGINT NOT NULL,
  granted_by BIGINT REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user ON user_scopes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_scopes_tenant ON user_scopes(tenant_id);

CREATE TABLE IF NOT EXISTS password_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS mfa_methods (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('TOTP','EMAIL','BACKUP_CODE')),
  secret_hash TEXT,
  verified_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, method)
);

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user ON mfa_backup_codes(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  device_type TEXT,
  os TEXT,
  browser TEXT,
  fingerprint_hash TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trust_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (trust_status IN ('TRUSTED','UNTRUSTED','BLOCKED','UNKNOWN')),
  risk_status TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_status IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id BIGINT REFERENCES devices(id) ON DELETE CASCADE,
  trusted_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS sod_conflicts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sod_rule_id BIGINT REFERENCES sod_rules(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
 status TEXT NOT NULL DEFAULT 'ACTIVE_CONFLICT' CHECK (status IN ('POTENTIAL_CONFLICT','ACTIVE_CONFLICT','EXCEPTION_APPROVED','RESOLVED')),
 details jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sod_conflicts_user ON sod_conflicts(user_id);
CREATE INDEX IF NOT EXISTS idx_sod_conflicts_status ON sod_conflicts(status);
CREATE INDEX IF NOT EXISTS idx_sod_conflicts_tenant ON sod_conflicts(tenant_id);

CREATE TABLE IF NOT EXISTS sod_exceptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sod_rule_id BIGINT REFERENCES sod_rules(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sod_exceptions_user ON sod_exceptions(user_id);
-- ---------- 3. Security and platform tables ----------
CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  details jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_tenant ON security_events(tenant_id);

CREATE TABLE IF NOT EXISTS ip_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('ALLOW_ALL','ALLOWLIST_ONLY','DENYLIST','RESTRICTED_NETWORK')),
  target TEXT NOT NULL,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  branch_id BIGINT REFERENCES branches(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  feature TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  environment TEXT,
  rollout INT NOT NULL DEFAULT 100 CHECK (rollout BETWEEN 0 AND 100),
  effective_from DATE,
  effective_to DATE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_flags_scope ON feature_flags (tenant_id, module, feature, COALESCE(company_id,0), COALESCE(branch_id,0));
CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant ON feature_flags(tenant_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','EXPIRED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE IF NOT EXISTS service_accounts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id BIGINT REFERENCES users(id),
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_hash TEXT,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS integration_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  integration TEXT NOT NULL,
  event TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'OUTBOUND' CHECK (direction IN ('INBOUND','OUTBOUND')),
  status TEXT NOT NULL DEFAULT 'OK',
  request jsonb,
  response jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_logs_created ON integration_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_integration_logs_tenant ON integration_logs(tenant_id);

CREATE TABLE IF NOT EXISTS notification_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP','EMAIL','SMS','WEBHOOK')),
  subject TEXT,
  body TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, channel)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS','WEBHOOK')),
  event_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, event_type)
);

CREATE TABLE IF NOT EXISTS notification_delivery_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  template_code TEXT,
  channel TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED','READ')),
  error TEXT,
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ndl_status ON notification_delivery_logs(status);
CREATE INDEX IF NOT EXISTS idx_ndl_tenant ON notification_delivery_logs(tenant_id);

CREATE TABLE IF NOT EXISTS document_numbering_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  branch_id BIGINT REFERENCES branches(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT '{PREFIX}-{YEAR}-{SEQ}',
  include_year BOOLEAN NOT NULL DEFAULT true,
  include_branch BOOLEAN NOT NULL DEFAULT false,
  include_department BOOLEAN NOT NULL DEFAULT false,
  pad INT NOT NULL DEFAULT 6,
  start_seq BIGINT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnr_scope ON document_numbering_rules (tenant_id, doc_type, COALESCE(company_id,0), COALESCE(branch_id,0));
CREATE INDEX IF NOT EXISTS idx_dnr_tenant ON document_numbering_rules(tenant_id);

CREATE TABLE IF NOT EXISTS number_sequences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  seq_key TEXT NOT NULL,
  doc_year INT NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seq_key, doc_year)
);

CREATE TABLE IF NOT EXISTS qr_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  branch_id BIGINT REFERENCES branches(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL DEFAULT 'HDG',
  format TEXT NOT NULL DEFAULT 'https://asset.hopedesign.example/t/{TOKEN}',
  payload_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  label_template TEXT,
  expiry_days INT NOT NULL DEFAULT 3650,
  replacement_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  void_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS configuration_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  config_key TEXT NOT NULL,
  old_value jsonb,
  new_value jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_configuration_history_created ON configuration_history(created_at);
CREATE INDEX IF NOT EXISTS idx_configuration_history_tenant ON configuration_history(tenant_id);

CREATE TABLE IF NOT EXISTS background_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'MAINTENANCE',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
 error TEXT,
 started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_background_jobs_tenant ON background_jobs(tenant_id);

CREATE TABLE IF NOT EXISTS job_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_id BIGINT REFERENCES background_jobs(id) ON DELETE CASCADE,
  run_no INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  result jsonb,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_tenant ON job_runs(tenant_id);

CREATE TABLE IF NOT EXISTS backup_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  backup_id TEXT NOT NULL,
  backup_type TEXT NOT NULL DEFAULT 'FULL' CHECK (backup_type IN ('FULL','INCREMENTAL','DIFFERENTIAL')),
  scope TEXT NOT NULL DEFAULT 'FULL_DATABASE',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','VERIFIED')),
  size_bytes BIGINT,
  retention_days INT NOT NULL DEFAULT 30,
  encrypted BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, backup_id)
);
CREATE INDEX IF NOT EXISTS idx_backup_records_tenant ON backup_records(tenant_id);

CREATE TABLE IF NOT EXISTS restore_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  backup_id BIGINT REFERENCES backup_records(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  risk_confirmed_at TIMESTAMPTZ,
  mfa_verified_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  recovery_point TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','RISK_CONFIRMED','MFA_VERIFIED','APPROVED','RUNNING','COMPLETED','FAILED','REJECTED')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restore_requests_tenant ON restore_requests(tenant_id);

CREATE TABLE IF NOT EXISTS system_health_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  component TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (status IN ('HEALTHY','WARNING','DEGRADED','CRITICAL','OFFLINE')),
  detail jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shl_checked ON system_health_logs(checked_at);
CREATE INDEX IF NOT EXISTS idx_shl_tenant ON system_health_logs(tenant_id);

CREATE TABLE IF NOT EXISTS database_health_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  component TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (status IN ('HEALTHY','WARNING','DEGRADED','CRITICAL','OFFLINE')),
  detail jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dhl_checked ON database_health_logs(checked_at);
CREATE INDEX IF NOT EXISTS idx_dhl_tenant ON database_health_logs(tenant_id);

CREATE TABLE IF NOT EXISTS user_profiles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  middle_name TEXT,
  display_name TEXT,
  profile_photo TEXT,
  locale TEXT,
  timezone TEXT,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS user_employment_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id BIGINT REFERENCES employees(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE,
  effective_to DATE,
  employment_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_uel_employee ON user_employment_links(employee_id);
-- ---------- 4. Seed administration permissions ----------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'admin', v.resource, v.action, v.description
FROM (VALUES
  ('admin.dashboard.view','dashboard','view','View the Administration dashboard'),
  ('admin.users.activate','users','activate','Activate user accounts'),
  ('admin.users.suspend','users','suspend','Suspend user accounts'),
  ('admin.users.invite','users','invite','Invite users to the platform'),
  ('admin.users.view_sessions','users','view_sessions','View a user active sessions'),
  ('admin.users.revoke_sessions','users','revoke_sessions','Revoke a user sessions'),
  ('admin.sessions.view','sessions','view','View active sessions'),
  ('admin.sessions.revoke','sessions','revoke','Revoke sessions'),
  ('admin.security.view','security','view','View the security center'),
  ('admin.feature_flags.view','feature_flags','view','View feature flags'),
  ('admin.feature_flags.update','feature_flags','update','Update feature flags'),
  ('admin.backups.view','backups','view','View backups'),
  ('admin.backups.restore','backups','restore','Approve or execute restores'),
  ('admin.health.view','health','view','View system health'),
  ('admin.integrations.view','integrations','view','View integrations'),
  ('admin.integrations.manage','integrations','manage','Manage integrations'),
  ('admin.organization.view','organization','view','View organization structure'),
  ('admin.organization.update','organization','update','Update organization structure'),
  ('admin.notifications.view','notifications','view','View notification administration'),
  ('admin.notifications.update','notifications','update','Manage notification templates'),
  ('admin.numbering.view','numbering','view','View numbering rules'),
  ('admin.numbering.update','numbering','update','Manage numbering rules'),
  ('admin.audit_logs.view','audit_logs','view','View audit logs')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- ---------- 5. Grant new permissions to administration roles ----------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'admin.dashboard.view','admin.users.activate','admin.users.suspend','admin.users.invite',
  'admin.users.view_sessions','admin.users.revoke_sessions','admin.sessions.view','admin.sessions.revoke',
  'admin.security.view','admin.feature_flags.view','admin.feature_flags.update','admin.backups.view',
  'admin.backups.restore','admin.health.view','admin.integrations.view','admin.integrations.manage',
  'admin.organization.view','admin.organization.update','admin.notifications.view','admin.notifications.update',
  'admin.numbering.view','admin.numbering.update','admin.audit_logs.view'
)
WHERE r.code IN ('super_administrator','system_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'admin.dashboard.view','admin.users.activate','admin.users.suspend','admin.users.invite',
  'admin.users.view_sessions','admin.users.revoke_sessions','admin.sessions.view','admin.sessions.revoke',
  'admin.security.view','admin.feature_flags.view','admin.audit_logs.view'
)
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'admin.dashboard.view','admin.health.view','admin.sessions.view','admin.integrations.view'
)
WHERE r.code = 'it_support_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('admin.dashboard.view','admin.audit_logs.view')
WHERE r.code = 'audit_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('admin.integrations.view','admin.integrations.manage')
WHERE r.code = 'integration_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('admin.backups.view','admin.backups.restore','admin.health.view','admin.dashboard.view')
WHERE r.code = 'backup_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------- 6. Audit triggers for new tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_invitations','user_status_history','user_permissions','permission_overrides',
    'policy_conditions','organization_scopes','user_scopes','password_history',
    'password_reset_tokens','mfa_methods','mfa_backup_codes','devices','trusted_devices',
    'sod_conflicts','sod_exceptions','security_events','ip_rules','feature_flags',
    'api_keys','service_accounts','webhooks','integration_logs','notification_templates',
    'notification_preferences','notification_delivery_logs','document_numbering_rules',
    'number_sequences','qr_settings','role_templates','configuration_history',
    'background_jobs','job_runs','backup_records','restore_requests','system_health_logs',
    'database_health_logs','user_profiles','user_employment_links'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'updated_at'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = t::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = t::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 7. Row-level security: tenant isolation ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_invitations','user_status_history','user_permissions','permission_overrides',
    'policy_conditions','organization_scopes','user_scopes','password_history',
    'password_reset_tokens','mfa_methods','mfa_backup_codes','devices','trusted_devices',
    'sod_conflicts','sod_exceptions','security_events','ip_rules','feature_flags',
    'api_keys','service_accounts','webhooks','integration_logs','notification_templates',
    'notification_preferences','notification_delivery_logs','document_numbering_rules',
    'number_sequences','qr_settings','role_templates','configuration_history',
    'background_jobs','job_runs','backup_records','restore_requests','system_health_logs',
    'database_health_logs','user_profiles','user_employment_links'
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
