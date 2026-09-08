-- ============================================================================
-- 0139 - Governance: Digital Signature Authority & Document Signing
-- HOPE DESIGN ERP official-document signature engine. Authorized employees
-- hold signature profiles with approval-limited authority scopes (per company,
-- branch, department, document type and maximum amount). Only ACTIVE profiles
-- inside their effective window can sign; signing snapshots the signatory
-- identity, role and any delegation reference into an immutable, QR-verifiable
-- document_signature_records row. Ordinary users can never edit a historical
-- signature record (privilege revoke + guard trigger + RLS).
-- Idempotent. All tables tenant scoped. Follows 0138 lifecycle conventions.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS signature_record_code_seq;

CREATE TABLE IF NOT EXISTS signature_profiles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  employee_id BIGINT REFERENCES employees(id),
  full_name TEXT NOT NULL,
  position_title TEXT NOT NULL,
  authority_level TEXT NOT NULL DEFAULT 'OTHER' CHECK (authority_level IN (
    'EXECUTIVE','MANAGEMENT','FINANCE','HR','OPERATIONS','TECHNICAL','SECURITY','OTHER'
  )),
  signature_asset_key TEXT,
  signature_url TEXT,
  signature_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','PENDING','ACTIVE','SUSPENDED','REVOKED','EXPIRED','REJECTED'
  )),
  approver_user_id BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  rejected_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  suspended_by BIGINT REFERENCES users(id),
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  revoked_by BIGINT REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_signature_profiles_user ON signature_profiles(user_id, status);
CREATE INDEX IF NOT EXISTS idx_signature_profiles_company ON signature_profiles(company_id, status);
CREATE INDEX IF NOT EXISTS idx_signature_profiles_window ON signature_profiles(status, effective_from, expires_at);

-- Approval-limited authority scopes attached to a profile. Only APPROVED
-- scopes authorize signing for a document type / amount combination.
CREATE TABLE IF NOT EXISTS signature_authority_scopes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  profile_id BIGINT NOT NULL REFERENCES signature_profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  transaction_type TEXT,
  max_amount NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approver_user_id BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, document_type, transaction_type)
);
CREATE INDEX IF NOT EXISTS idx_signature_scopes_profile ON signature_authority_scopes(profile_id, status);

-- Immutable applied-signature records (append only). Each row is a snapshot of
-- the signatory identity, role, authority scope and (when acting) delegation,
-- plus an opaque verification code and the SHA-256 hash of the verify token.
CREATE TABLE IF NOT EXISTS document_signature_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  code TEXT NOT NULL DEFAULT ('SIG-' || to_char(now(),'YYYY') || '-' || lpad(nextval('signature_record_code_seq')::text,6,'0')),
  user_id BIGINT NOT NULL REFERENCES users(id),
  profile_id BIGINT NOT NULL REFERENCES signature_profiles(id),
  delegation_id BIGINT REFERENCES delegations(id),
  document_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  document_code TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  amount NUMERIC(18,2),
  signatory_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  authority_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_code TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (verification_code)
);
CREATE INDEX IF NOT EXISTS idx_doc_sig_records_doc ON document_signature_records(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_doc_sig_records_code ON document_signature_records(company_id, document_code);
CREATE INDEX IF NOT EXISTS idx_doc_sig_records_user ON document_signature_records(user_id);

-- Mark signature profiles whose status window has closed as EXPIRED.
CREATE OR REPLACE FUNCTION public.governance_expire_signature_profiles()
RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE signature_profiles
     SET status = 'EXPIRED',
         updated_by = NULL,
         updated_at = now()
   WHERE status IN ('ACTIVE','PENDING')
     AND expires_at IS NOT NULL
     AND expires_at <= now()
   RETURNING 1 INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.governance_expire_signature_profiles() TO hopedesign_app;

-- ============================================================================
-- RLS + triggers
-- ============================================================================
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['signature_profiles','signature_authority_scopes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = app_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON public.%I FOR INSERT WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_isolation_update ON public.%I FOR UPDATE USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_isolation_delete ON public.%I FOR DELETE USING (tenant_id = app_tenant_id())', t);
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;

-- Applied signature records: select + insert only (immutable snapshots).
ALTER TABLE public.document_signature_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.document_signature_records;
DROP POLICY IF EXISTS tenant_isolation_insert ON public.document_signature_records;
CREATE POLICY tenant_isolation_select ON public.document_signature_records
  FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation_insert ON public.document_signature_records
  FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
DROP TRIGGER IF EXISTS trg_audit_trail_append_only ON public.document_signature_records;
CREATE TRIGGER trg_audit_trail_append_only
  BEFORE UPDATE OR DELETE ON public.document_signature_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_append_only();
DROP TRIGGER IF EXISTS trg_audit ON public.document_signature_records;
CREATE TRIGGER trg_audit AFTER INSERT ON public.document_signature_records
  FOR EACH ROW EXECUTE FUNCTION audit_row();
REVOKE UPDATE, DELETE, TRUNCATE ON public.document_signature_records FROM hopedesign_app;
