-- ============================================================================
-- 0138 - Governance: Delegation & Acting Authority
-- HOPE DESIGN ERP continuity engine. When a key person is absent the company
-- keeps operating through explicit, time-boxed delegations that merge the
-- temporary role's permissions into the delegate's active session, auto-expire
-- at the end of the window and leave a full lifecycle audit trail.
-- Lifecycle: DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE
--           -> SUSPENDED/EXPIRED/REVOKED/REJECTED/CANCELLED
-- APPROVED = approved but not yet inside its effective window. ACTIVE rows are
-- the only rows whose permissions are merged at authentication time.
-- Idempotent: safe on fresh + existing DB. All tables are tenant scoped.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS delegation_code_seq;

CREATE TABLE IF NOT EXISTS delegations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  code TEXT NOT NULL DEFAULT ('DLG-' || to_char(now(),'YYYY') || '-' || lpad(nextval('delegation_code_seq')::text,6,'0')),
  delegator_user_id BIGINT NOT NULL REFERENCES users(id),
  delegate_user_id BIGINT NOT NULL REFERENCES users(id),
  original_role_id BIGINT NOT NULL REFERENCES roles(id),
  temporary_role_id BIGINT NOT NULL REFERENCES roles(id),
  reason TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_limit NUMERIC(18,2),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','ACTIVE','SUSPENDED',
    'EXPIRED','REVOKED','REJECTED','CANCELLED'
  )),
  approver_user_id BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  rejected_by BIGINT REFERENCES users(id),
  rejected_at TIMESTAMPTZ,
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
  CHECK (expires_at > starts_at),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON delegations(delegate_user_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_delegator ON delegations(delegator_user_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_window ON delegations(status, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_delegations_company ON delegations(company_id, status);

-- Per-transaction-type granular authority granted by the delegation.
CREATE TABLE IF NOT EXISTS delegation_authorities (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  delegation_id BIGINT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL,
  can_approve BOOLEAN NOT NULL DEFAULT true,
  can_create BOOLEAN NOT NULL DEFAULT false,
  max_amount NUMERIC(18,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delegation_id, transaction_type)
);
CREATE INDEX IF NOT EXISTS idx_delegation_authorities_type ON delegation_authorities(delegation_id, transaction_type);

-- Immutable-ish lifecycle trail (append only via service layer; row-level audit
-- is also applied so ordinary users cannot silently alter the history).
CREATE TABLE IF NOT EXISTS delegation_status_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  delegation_id BIGINT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by BIGINT REFERENCES users(id),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delegation_status_history_dlg ON delegation_status_history(delegation_id, created_at);

-- Mark ACTIVE delegations whose window has closed as EXPIRED. Runs as the
-- invoker (RLS keeps the sweep scoped to the current tenant context).
CREATE OR REPLACE FUNCTION public.governance_expire_delegations()
RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE delegations
     SET status = 'EXPIRED',
         updated_by = NULL,
         updated_at = now()
   WHERE status = 'ACTIVE'
     AND expires_at <= now()
   RETURNING 1 INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.governance_expire_delegations() TO hopedesign_app;

-- ============================================================================
-- RLS + triggers
-- ============================================================================
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['delegations','delegation_authorities','delegation_status_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['delegations','delegation_authorities'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['delegations','delegation_authorities','delegation_status_history'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- Permissions (governance module) + role grants. Idempotent.
-- ============================================================================
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('governance.delegations.view','governance','delegations','view','View delegation and acting authority records'),
  ('governance.delegations.create','governance','delegations','create','Create delegation drafts'),
  ('governance.delegations.update','governance','delegations','update','Update delegation drafts'),
  ('governance.delegations.submit','governance','delegations','submit','Submit a delegation for approval'),
  ('governance.delegations.approve','governance','delegations','approve','Approve a delegation'),
  ('governance.delegations.reject','governance','delegations','reject','Reject a delegation'),
  ('governance.delegations.suspend','governance','delegations','suspend','Suspend an active delegation'),
  ('governance.delegations.resume','governance','delegations','resume','Resume a suspended delegation'),
  ('governance.delegations.revoke','governance','delegations','revoke','Revoke a delegation before its expiry'),
  ('governance.delegations.expire','governance','delegations','expire','Manually expire an out-of-window delegation'),
  ('governance.delegations.cancel','governance','delegations','cancel','Cancel a delegation that is not yet active'),
  ('governance.delegation_authorities.view','governance','delegation_authorities','view','View delegation transaction authorities'),
  ('governance.delegation_authorities.create','governance','delegation_authorities','create','Add transaction authority rows to a delegation'),
  ('governance.delegation_authorities.update','governance','delegation_authorities','update','Update delegation transaction authorities'),
  ('governance.delegation_authorities.delete','governance','delegation_authorities','delete','Remove delegation transaction authorities'),
  ('governance.acting_roles.view','governance','acting_roles','view','View active acting authority assigned to a user'),
  ('governance.acting_roles.export','governance','acting_roles','export','Export acting authority records'),
  ('governance.signature_profiles.view','governance','signature_profiles','view','View digital signature profiles'),
  ('governance.signature_profiles.create','governance','signature_profiles','create','Create a digital signature profile'),
  ('governance.signature_profiles.update','governance','signature_profiles','update','Update a digital signature profile'),
  ('governance.signature_profiles.submit','governance','signature_profiles','submit','Submit a signature profile for approval'),
  ('governance.signature_profiles.approve','governance','signature_profiles','approve','Approve a signature profile'),
  ('governance.signature_profiles.reject','governance','signature_profiles','reject','Reject a signature profile'),
  ('governance.signature_profiles.activate','governance','signature_profiles','activate','Activate an approved signature profile'),
  ('governance.signature_profiles.suspend','governance','signature_profiles','suspend','Suspend a signature profile'),
  ('governance.signature_profiles.revoke','governance','signature_profiles','revoke','Revoke a signature profile'),
  ('governance.signature_profiles.expire','governance','signature_profiles','expire','Expire a signature profile'),
  ('governance.signature_profiles.upload','governance','signature_profiles','upload','Upload signature artwork or drawn signature data'),
  ('governance.signature_authority_scopes.view','governance','signature_authority_scopes','view','View signature authority scopes'),
  ('governance.signature_authority_scopes.create','governance','signature_authority_scopes','create','Create signature authority scopes'),
  ('governance.signature_authority_scopes.update','governance','signature_authority_scopes','update','Update signature authority scopes'),
  ('governance.signature_authority_scopes.delete','governance','signature_authority_scopes','delete','Delete signature authority scopes'),
  ('governance.signature_authority_scopes.approve','governance','signature_authority_scopes','approve','Approve signature authority scopes'),
  ('governance.document_signatures.view','governance','document_signatures','view','View applied document signature records'),
  ('governance.document_signatures.create','governance','document_signatures','create','Apply an authorized signature to a document'),
  ('governance.document_signatures.verify','governance','document_signatures','verify','Verify a signed document via its opaque verification token'),
  ('governance.document_signatures.export','governance','document_signatures','export','Export document signature records')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Full governance administration (already-seeded DBs; fresh DBs are granted by
-- the catalogue seed which mirrors these codes).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'governance.%'
WHERE r.code IN (
  'super_administrator','managing_director','ceo','executive_director','general_manager',
  'hr_director','hr_manager'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- System administrator: traceability only (never business document signing).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'governance.delegations.view','governance.signature_profiles.view',
  'governance.document_signatures.view','governance.document_signatures.verify'
)
WHERE r.code = 'system_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Security administrator: oversight + revocation rights, no business signing.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'governance.delegations.view','governance.delegations.revoke',
  'governance.signature_profiles.view','governance.signature_profiles.revoke',
  'governance.document_signatures.view','governance.document_signatures.verify'
)
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Operations director: oversight of acting authority and operational signing.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'governance.delegations.view','governance.acting_roles.view',
  'governance.document_signatures.view','governance.document_signatures.create',
  'governance.document_signatures.verify'
)
WHERE r.code = 'operations_director'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- HR officer: HR administrative support reads.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'governance.delegations.view','governance.signature_profiles.view',
  'governance.document_signatures.view'
)
WHERE r.code = 'hr_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Employee self service: manage own signature profile only (ABAC scopes the
-- rows to the signed-in user).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'governance.signature_profiles.view','governance.signature_profiles.create',
  'governance.signature_profiles.submit','governance.signature_profiles.upload',
  'governance.document_signatures.verify'
)
WHERE r.code = 'employee_self_service'
ON CONFLICT (role_id, permission_id) DO NOTHING;
