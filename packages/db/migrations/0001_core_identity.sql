-- ============================================================
-- Hope Design ERP ? 0001 Core identity, org structure, security
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jsonb_diff(old JSONB, new JSONB) RETURNS JSONB AS $$
DECLARE result JSONB := '{}'::jsonb; key TEXT;
BEGIN
  IF old IS NULL THEN old := '{}'::jsonb; END IF;
  IF new IS NULL THEN new := '{}'::jsonb; END IF;
  FOR key IN SELECT * FROM jsonb_object_keys(old) LOOP
    IF NOT (new ? key) OR old->key IS DISTINCT FROM new->key THEN
      result := jsonb_set(result, ARRAY[key], jsonb_build_object('old', old->key, 'new', new->key));
    END IF;
  END LOOP;
  FOR key IN SELECT * FROM jsonb_object_keys(new) LOOP
    IF NOT (old ? key) AND new->key IS NOT NULL THEN
      result := jsonb_set(result, ARRAY[key], jsonb_build_object('old', NULL, 'new', new->key));
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Tenant data access context (set per request by the API)
CREATE OR REPLACE FUNCTION set_app_context(p_tenant bigint, p_company bigint DEFAULT NULL, p_branch bigint DEFAULT NULL, p_user bigint DEFAULT NULL)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('app.company_id', COALESCE(p_company::text, ''), true);
  PERFORM set_config('app.branch_id', COALESCE(p_branch::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(p_user::text, ''), true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS bigint AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::bigint;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_company_id() RETURNS bigint AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::bigint;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_branch_id() RETURNS bigint AS $$
  SELECT NULLIF(current_setting('app.branch_id', true), '')::bigint;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS bigint AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::bigint;
$$ LANGUAGE sql STABLE;

-- Sequential document numbers e.g. HDG-FG-2026-00000001
CREATE TABLE document_numbers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  prefix TEXT NOT NULL,
  doc_year INTEGER NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, prefix, doc_year)
);

CREATE OR REPLACE FUNCTION next_doc_no(p_tenant bigint, p_prefix text, p_pad integer DEFAULT 8)
RETURNS text AS $$
DECLARE seq bigint; y integer := EXTRACT(YEAR FROM now())::int;
BEGIN
  INSERT INTO document_numbers (tenant_id, prefix, doc_year)
  VALUES (p_tenant, p_prefix, y)
  ON CONFLICT (tenant_id, prefix, doc_year) DO UPDATE SET last_seq = document_numbers.last_seq + 1
  RETURNING last_seq INTO seq;
  IF seq IS NULL THEN
    SELECT last_seq INTO seq FROM document_numbers
    WHERE tenant_id = p_tenant AND prefix = p_prefix AND doc_year = y;
  END IF;
  RETURN p_prefix || '-' || y || '-' || lpad(seq::text, p_pad, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------- organisation ----------
CREATE TABLE tenants (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  tin TEXT,
  vrn TEXT,
  currency TEXT NOT NULL DEFAULT 'UGX',
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  fiscal_year_start TEXT NOT NULL DEFAULT '07-01',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  manager_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  head_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_facilities (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cost_centres (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profit_centres (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- warehouses / locations ----------
CREATE TABLE warehouses (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  facility_id BIGINT REFERENCES production_facilities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'FINISHED_GOODS'
    CHECK (type IN ('RAW_MATERIAL','WIP','FINISHED_GOODS','SECURE','QUARANTINE','DAMAGED','RETURNS','CONSUMABLES','SPARE_PARTS','GENERAL')),
  address TEXT,
  is_secure BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_zones (
  id BIGSERIAL PRIMARY KEY,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  UNIQUE (warehouse_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_racks (
  id BIGSERIAL PRIMARY KEY,
  zone_id BIGINT NOT NULL REFERENCES warehouse_zones(id),
  code TEXT NOT NULL,
  UNIQUE (zone_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_shelves (
  id BIGSERIAL PRIMARY KEY,
  rack_id BIGINT NOT NULL REFERENCES warehouse_racks(id),
  code TEXT NOT NULL,
  UNIQUE (rack_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_bins (
  id BIGSERIAL PRIMARY KEY,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  shelf_id BIGINT REFERENCES warehouse_shelves(id),
  code TEXT NOT NULL,
  name TEXT,
  barcode TEXT,
  is_secure BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (warehouse_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- security: users ----------
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  employee_id BIGINT,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  job_title TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','LOCKED','PENDING','SUSPENDED')),
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret TEXT,
  mfa_method TEXT,
  last_login_at TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  -- ABAC attributes
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_company ON users(company_id);

CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  mfa_verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  ip TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts ON login_attempts(identifier, created_at DESC);

-- ---------- RBAC ----------
CREATE TABLE permissions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  module TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_customizable BOOLEAN NOT NULL DEFAULT true,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code)
);

CREATE TABLE role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  PRIMARY KEY (user_id, role_id)
);

-- ---------- ABAC ----------
CREATE TABLE policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  priority INTEGER NOT NULL DEFAULT 100,
  -- attribute matchers (JSONB); empty {} matches anything
  subject_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  resource_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  environment_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approval_limits (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  min_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, role_id, module, currency)
);

-- ---------- Segregation of duties ----------
CREATE TABLE sod_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- conflicting permission pair; a user holding both is a conflict
  primary_permission TEXT NOT NULL,
  conflicting_permission TEXT NOT NULL,
  enforcement TEXT NOT NULL DEFAULT 'hard' CHECK (enforcement IN ('hard','warn')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- audit & events (created early so triggers can reference) ----------
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT,
  company_id BIGINT,
  branch_id BIGINT,
  user_id BIGINT,
  correlation_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  record_id BIGINT,
  record_code TEXT,
  old_values JSONB,
  new_values JSONB,
  changes JSONB,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_logs(resource, record_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id);

CREATE TABLE system_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT,
  company_id BIGINT,
  branch_id BIGINT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  entity_code TEXT,
  user_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('DEBUG','INFO','WARN','ERROR','CRITICAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_type ON system_events(event_type, created_at DESC);
CREATE INDEX idx_events_entity ON system_events(entity_type, entity_id);

-- ---------- system configuration ----------
CREATE TABLE configs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  UNIQUE (tenant_id, key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Row-level security ----------
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_racks ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_shelves ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_bins ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE sod_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON companies USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON branches USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON departments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_facilities USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON cost_centres USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON profit_centres USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON warehouses USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON warehouse_zones USING (warehouse_id IN (SELECT id FROM warehouses));
CREATE POLICY tenant_isolation ON warehouse_racks USING (zone_id IN (SELECT id FROM warehouse_zones));
CREATE POLICY tenant_isolation ON warehouse_shelves USING (rack_id IN (SELECT id FROM warehouse_racks));
CREATE POLICY tenant_isolation ON warehouse_bins USING (warehouse_id IN (SELECT id FROM warehouses));
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON roles USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON policies USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON approval_limits USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sod_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON configs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON document_numbers USING (tenant_id = app_tenant_id());

-- API user is intentionally BYPASSRLS via a dedicated role (see docs);
-- RLS remains the last line of defence for non-privileged connections.
