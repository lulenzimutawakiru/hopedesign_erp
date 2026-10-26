-- ===========================================================================
-- 0207 - ISO operating controls
--
-- The alignment register (0206) only describes the system. This migration is
-- the part that operates the controls: a policy library, the records the
-- gaps named, and the database checks those records have to satisfy.
--
-- A caller still cannot edit the assessment. These tables are the company's
-- own evidence. Status changes on the register stay in the API source.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

-- ---------- 1. Policy library ----------
CREATE TABLE IF NOT EXISTS iso_policies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'ISMS_POLICY', 'ACCEPTABLE_USE', 'AWARENESS', 'OPERATING_PROCEDURE',
    'INCIDENT_PLAN', 'SECURE_DEVELOPMENT', 'SECURE_CODING', 'ARCHITECTURE',
    'SECURITY_REQUIREMENTS', 'TEST_DATA', 'AUDIT_TESTING', 'REMOTE_WORK',
    'CLEAR_DESK', 'NETWORK', 'CLOUD_RESPONSIBILITY'
  )),
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'RETIRED')),
  owner_role TEXT NOT NULL,
  next_review_on DATE,
  -- Null means every user of the company. A set user is a targeted
  -- acknowledgement, used so one person's gate does not lock the company.
  subject_user_id BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code, version),
  CONSTRAINT iso_policies_approved_chk CHECK (
    status <> 'APPROVED'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND next_review_on IS NOT NULL
      AND approved_by IS DISTINCT FROM created_by
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_iso_policies_company
  ON iso_policies (company_id, kind, status);

CREATE TABLE IF NOT EXISTS iso_acknowledgements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  policy_id BIGINT NOT NULL REFERENCES iso_policies(id),
  policy_version TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, policy_id, policy_version)
);

-- ---------- 2. Operating records ----------
CREATE TABLE IF NOT EXISTS iso_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'objective', 'authority_contact', 'interest_group', 'threat_advisory',
    'information_asset', 'transfer_agreement', 'access_review', 'supplier_review',
    'supplier_clause', 'supplier_service_review', 'cloud_share', 'security_event',
    'incident', 'lesson', 'continuity', 'licence', 'independent_review',
    'screening', 'awareness', 'remote_standard', 'perimeter', 'physical_entry',
    'facility', 'physical_monitor', 'environmental', 'secure_area', 'media',
    'utility', 'cabling', 'equipment_protection', 'off_premises',
    'disposal_certificate', 'maintenance_release', 'endpoint', 'capacity',
    'vulnerability', 'deletion_proof', 'network_rule', 'network_agreement',
    'source_access', 'host_software', 'clock_check', 'sbom', 'dev_standard',
    'security_requirement', 'architecture_principle', 'coding_standard',
    'security_test', 'environment_boundary', 'test_data_rule', 'audit_isolation',
    'quality_plan', 'requirement_review', 'customer_property', 'preservation_limit',
    'preservation_reading', 'post_delivery', 'measurement_plan', 'internal_audit',
    'audit_finding', 'improvement', 'project_gate', 'policy_review',
    'outsourced_development'
  )),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CURRENT', 'CLOSED', 'REJECTED')),
  title TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  subject_table TEXT,
  subject_id BIGINT,
  due_on DATE,
  reviewed_on DATE,
  closed_on DATE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iso_entries_subject
  ON iso_entries (tenant_id, entry_type, status, subject_table, subject_id);

-- ---------- 3. Supplier approval ----------
-- Existing active suppliers stay buyable for a year. A supplier created after
-- this migration stays PENDING until a quality and security review is recorded.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS iso_review_status TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_iso_review_status_check;
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_iso_review_status_check
  CHECK (iso_review_status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'));

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS iso_review_due DATE;

UPDATE suppliers
   SET iso_review_status = 'APPROVED',
       iso_review_due = CURRENT_DATE + 365
 WHERE status IN ('ACTIVE', 'APPROVED')
   AND iso_review_status = 'PENDING'
   AND iso_review_due IS NULL;

-- ---------- 4. Acknowledgement gate ----------
-- Returns the title of the first approved policy this user has not accepted.
-- A null result means the session may proceed.
CREATE OR REPLACE FUNCTION iso_pending_acknowledgement(p_user BIGINT, p_company BIGINT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT p.title
    FROM iso_policies p
   WHERE p.company_id = p_company
     AND p.status = 'APPROVED'
     AND p.kind IN ('ACCEPTABLE_USE', 'AWARENESS', 'CLEAR_DESK')
     AND p.next_review_on >= CURRENT_DATE
     AND (p.subject_user_id IS NULL OR p.subject_user_id = p_user)
     AND NOT EXISTS (
       SELECT 1 FROM iso_acknowledgements a
        WHERE a.user_id = p_user
          AND a.policy_id = p.id
          AND a.policy_version = p.version
     )
   ORDER BY p.id
   LIMIT 1;
$$;

-- ---------- 5. Seeds that are the system's own stores, not a fake review ----------
INSERT INTO iso_entries (company_id, tenant_id, entry_type, status, title, owner_role, payload)
SELECT c.id, c.tenant_id, 'information_asset', 'CURRENT', v.title, v.owner_role, v.payload::jsonb
  FROM companies c
  CROSS JOIN (VALUES
    ('Payroll and employee identity', 'HR director', '{"store":"employees, payroll, identity documents","classification":"RESTRICTED"}'),
    ('Finance ledgers and bank feeds', 'System administrator', '{"store":"journals, bank notifications, EFRIS","classification":"CONFIDENTIAL"}'),
    ('Mailboxes', 'System administrator', '{"store":"mail messages and attachments","classification":"INTERNAL"}'),
    ('Audit log', 'Internal auditor', '{"store":"audit_logs","classification":"RESTRICTED"}'),
    ('Security-printing jobs', 'Security administrator', '{"store":"security_jobs","classification":"RESTRICTED"}'),
    ('Application database and integrations', 'System administrator', '{"store":"Postgres, Redis, integration secrets","classification":"RESTRICTED"}')
  ) AS v(title, owner_role, payload)
 WHERE NOT EXISTS (
   SELECT 1 FROM iso_entries e
    WHERE e.company_id = c.id AND e.entry_type = 'information_asset' AND e.title = v.title
 );

INSERT INTO iso_entries (company_id, tenant_id, entry_type, status, title, owner_role, due_on, payload)
SELECT c.id, c.tenant_id, 'access_review', 'OPEN',
       'Annual access recertification', 'Security administrator',
       CURRENT_DATE + 365,
       '{"cycle":"annual"}'::jsonb
  FROM companies c
 WHERE NOT EXISTS (
   SELECT 1 FROM iso_entries e
    WHERE e.company_id = c.id AND e.entry_type = 'access_review' AND e.title = 'Annual access recertification'
 );

INSERT INTO iso_entries (company_id, tenant_id, entry_type, status, title, owner_role, due_on, reviewed_on, payload)
SELECT c.id, c.tenant_id, v.entry_type, 'CURRENT', v.title, 'System administrator',
       CURRENT_DATE + 365, CURRENT_DATE, v.payload::jsonb
  FROM companies c
  CROSS JOIN (VALUES
    ('dev_standard', 'Secure development procedure', '{"path":"docs/SECURE_DEVELOPMENT.md","statement":"Changes pass the test workflow and the security workflow before they reach main."}'),
    ('coding_standard', 'Secure coding procedure', '{"path":"docs/SECURE_DEVELOPMENT.md","statement":"Authorization is server-side, inputs are checked at the route, and secrets are not returned to the client."}'),
    ('architecture_principle', 'Engineering principles', '{"path":"docs/SECURE_DEVELOPMENT.md","statement":"Deny by default, force row-level security, and run the application as a role that is not a superuser."}'),
    ('security_requirement', 'Application security requirements', '{"path":"docs/SECURE_DEVELOPMENT.md","statement":"The requirements the middleware enforces are listed in the secure-development procedure and retested by the API suite."}'),
    ('test_data_rule', 'Test data rule', '{"path":"docs/SECURE_DEVELOPMENT.md","rule":"Production personal data is not copied into a development or test database. Tests build their own rows."}'),
    ('audit_isolation', 'Audit testing procedure', '{"path":"docs/SECURE_DEVELOPMENT.md","procedure":"Audit tests are non-destructive. A probe that changes data is reverted before the tester leaves."}'),
    ('environment_boundary', 'Environment boundary', '{"path":"docs/SECURE_DEVELOPMENT.md","environment":"Development, test and production are separate Compose projects. Production personal data stays in production."}'),
    ('network_rule', 'Production network rule', '{"path":"deploy/NETWORK.md","rule":"Public ports are 80 and 443. Postgres and Redis are not published."}'),
    ('cloud_share', 'Cloud shared responsibility', '{"path":"docs/CLOUD_RESPONSIBILITY.md","provider":"self-hosted VPS plus the mail, bank and tax services the company connects","responsibility":"Hope Design operates the application, the database and the host firewall. Each connected service is responsible for its own platform."}')
  ) AS v(entry_type, title, payload)
 WHERE NOT EXISTS (
   SELECT 1 FROM iso_entries e
    WHERE e.company_id = c.id AND e.entry_type = v.entry_type AND e.title = v.title
 );

-- ---------- 6. Row security, audit, privileges ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['iso_policies', 'iso_acknowledgements', 'iso_entries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = app_tenant_id())',
      t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass('public.' || t)
    ) AND t <> 'iso_acknowledgements' THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_audit ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON iso_policies, iso_acknowledgements, iso_entries TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE iso_policies_id_seq, iso_acknowledgements_id_seq, iso_entries_id_seq TO hopedesign_app;
GRANT EXECUTE ON FUNCTION iso_pending_acknowledgement(BIGINT, BIGINT) TO hopedesign_app;

-- ---------- 7. Permissions ----------
-- Mirrored in packages/db/src/catalogue.js. A later seed rebuilds
-- role_permissions from the catalogue, so the grants below are repeated there.
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'compliance', 'operating', v.action, v.description
  FROM (VALUES
    ('compliance.operating.view', 'view', 'View ISO operating records'),
    ('compliance.operating.manage', 'manage', 'Maintain ISO policies and operating records')
  ) AS v(code, action, description)
 WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.code IN ('compliance.operating.view', 'compliance.operating.manage')
 WHERE r.code IN (
   'super_administrator', 'ceo', 'system_administrator', 'security_administrator',
   'data_protection_officer', 'quality_director', 'quality_manager',
   'hr_director', 'hr_manager', 'sales_director', 'sales_manager',
   'procurement_director', 'procurement_manager', 'production_director', 'production_manager'
 )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.code = 'compliance.operating.view'
 WHERE r.code IN ('audit_administrator', 'internal_auditor', 'qa_auditor')
ON CONFLICT (role_id, permission_id) DO NOTHING;

UPDATE roles r
   SET permissions = r.permissions || '["compliance.operating.view","compliance.operating.manage"]'::jsonb,
       updated_at = now()
 WHERE r.code IN (
        'super_administrator', 'ceo', 'system_administrator', 'security_administrator',
        'data_protection_officer', 'quality_director', 'quality_manager',
        'hr_director', 'hr_manager', 'sales_director', 'sales_manager',
        'procurement_director', 'procurement_manager', 'production_director', 'production_manager'
      )
   AND jsonb_typeof(r.permissions) = 'array'
   AND r.permissions @> '["compliance.operating.manage"]'::jsonb IS NOT TRUE;

UPDATE roles r
   SET permissions = r.permissions || '["compliance.operating.view"]'::jsonb,
       updated_at = now()
 WHERE r.code IN ('audit_administrator', 'internal_auditor', 'qa_auditor')
   AND jsonb_typeof(r.permissions) = 'array'
   AND r.permissions @> '["compliance.operating.view"]'::jsonb IS NOT TRUE;
