-- ============================================================================
-- 0116 - Enterprise Document Management System (DMS)
-- Folders, document registry, versioning, review/approval workflow, retention,
-- classification and settings for HOPE DESIGN ERP.
-- Idempotent: safe on fresh + existing DB. Tables are prefixed dms_* to avoid
-- colliding with the HR documents table from migration 0011.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Folders
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_folders (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  parent_id BIGINT REFERENCES dms_folders(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_dms_folders_parent ON dms_folders(tenant_id, parent_id);

-- ------------------------------------------------------------
-- 2. Document registry
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS dms_documents_seq;

CREATE TABLE IF NOT EXISTS dms_documents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  folder_id BIGINT REFERENCES dms_folders(id) ON DELETE SET NULL,
  code TEXT NOT NULL DEFAULT ('DOC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('dms_documents_seq')::text, 6, '0')),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'OTHER' CHECK (category IN (
    'POLICY','PROCEDURE','CONTRACT','CERTIFICATE','QUALITY','MAINTENANCE','PRODUCTION',
    'HR','FINANCE','PURCHASE','SALES','LOGISTICS','ASSET','SECURITY','REPORT','OTHER'
  )),
  classification TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (classification IN (
    'PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'
  )),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','IN_REVIEW','APPROVED','RELEASED','ARCHIVED','OBSOLETE'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  file_name TEXT,
  file_type TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_path TEXT,
  content_hash TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  owner_id BIGINT REFERENCES users(id),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_until DATE,
  is_template BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_dms_documents_folder ON dms_documents(tenant_id, folder_id, status);
CREATE INDEX IF NOT EXISTS idx_dms_documents_status ON dms_documents(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_dms_documents_category ON dms_documents(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_dms_documents_entity ON dms_documents(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_dms_documents_retention ON dms_documents(tenant_id, retention_until);

-- ------------------------------------------------------------
-- 3. Versions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_versions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  document_id BIGINT NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  file_name TEXT,
  file_type TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_path TEXT,
  content_hash TEXT,
  change_note TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_dms_versions_doc ON dms_versions(document_id, version DESC);

-- ------------------------------------------------------------
-- 4. Review / approval trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  document_id BIGINT NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
  version_id BIGINT REFERENCES dms_versions(id) ON DELETE SET NULL,
  reviewer_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN (
    'SUBMITTED','APPROVED','REJECTED','REQUEST_CHANGES','RELEASED','ARCHIVED','OBSOLETE','RESTORED'
  )),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dms_reviews_doc ON dms_reviews(document_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. Settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, category, key)
);

-- ------------------------------------------------------------
-- 6. RLS + updated_at triggers
-- ------------------------------------------------------------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['dms_folders','dms_documents','dms_versions','dms_reviews','dms_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 7. Permissions (module: documents)
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'documents', v.resource, v.action, v.description
FROM (VALUES
  ('documents.command.view','command','view','View the document command centre'),
  ('documents.view','library','view','View documents in the library'),
  ('documents.create','library','create','Create documents'),
  ('documents.edit','library','edit','Edit document metadata'),
  ('documents.upload','library','upload','Upload document files and new versions'),
  ('documents.download','library','download','Download document files'),
  ('documents.approve','library','approve','Approve, reject and release documents'),
  ('documents.delete','library','delete','Delete or archive documents'),
  ('documents.folders.manage','folders','manage','Manage document folders'),
  ('documents.settings.manage','settings','manage','Configure document management settings')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'documents.%'
WHERE r.code IN (
  'super_administrator','system_administrator','managing_director','executive_director',
  'general_manager','operations_director','production_director','production_manager',
  'production_planner','production_supervisor','quality_manager','quality_inspector',
  'warehouse_manager','storekeeper','cfo','finance_manager','chief_accountant',
  'hr_manager','procurement_manager','maintenance_manager','logistics_manager',
  'sales_manager','commercial_director','internal_auditor'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ------------------------------------------------------------
-- 8. Seed: default folders (HDG tenant)
-- ------------------------------------------------------------
INSERT INTO dms_folders (tenant_id, company_id, branch_id, parent_id, code, name, description, is_system, created_by)
SELECT t.id, c.id, b.id, NULL, v.code, v.name, v.description, true,
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1)
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
CROSS JOIN (VALUES
  ('QMS','Quality Management System','Policies, manuals and quality records for the factory'),
  ('PRODUCTION','Production Standards','NATEX A4 production standards, settings and formulas'),
  ('MAINTENANCE','Maintenance','Preventive maintenance plans and machine records'),
  ('HR','Human Resources','Policies, contracts and HR procedures'),
  ('FINANCE','Finance','Financial policies, budgets and reports'),
  ('PURCHASE','Procurement','Supplier contracts, agreements and purchasing procedures'),
  ('CERTIFICATES','Certificates','Certificates of analysis, compliance and calibration'),
  ('REPORTS','Reports','Published operational and management reports')
) AS v(code, name, description)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM dms_folders f WHERE f.tenant_id = t.id AND f.code = v.code);

-- ------------------------------------------------------------
-- 9. Seed: sample documents + versions (HDG tenant)
-- ------------------------------------------------------------
INSERT INTO dms_documents (tenant_id, company_id, branch_id, folder_id, code, title, description, category, classification, status, version, file_name, file_type, file_size, entity_type, entity_id, owner_id, tags, retention_until, is_template, created_by, updated_by, created_at, updated_at)
SELECT t.id, c.id, b.id,
       (SELECT f.id FROM dms_folders f WHERE f.tenant_id = t.id AND f.code = v.folder LIMIT 1),
       v.code, v.title, v.description, v.category, v.classification, v.status, v.version,
       v.file_name, v.file_type, v.file_size, v.entity_type, NULL, u.id,
       v.tags::jsonb, v.retention_until::date, v.is_template, u.id, u.id, now() - v.ago, now() - v.ago
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
JOIN users u ON u.tenant_id = t.id AND u.username = 'admin'
CROSS JOIN (VALUES
  ('DOC-2026-0001','NATEX A4 Production Standard','Master production standard for NATEX A4 80gsm premium superior white: 880mm jumbo conversion, SCA4-1100 settings, ream/carton/pallet configuration and quality limits.','PRODUCTION','INTERNAL','RELEASED',2,'natex-a4-production-standard-v2.pdf','application/pdf',842136,'work_orders','["natex","a4","production","standard"]','PRODUCTION',false,NULL,interval '120 days'),
  ('DOC-2026-0002','Quality Manual','HOPE DESIGN factory quality manual covering incoming, in-process and finished goods QC with sampling plans.','QUALITY','INTERNAL','RELEASED',1,'quality-manual-v1.pdf','application/pdf',1254870,'quality','["quality","manual"]','QMS',false,NULL,interval '150 days'),
  ('DOC-2026-0003','SCA4-1100 Preventive Maintenance Plan','Monthly and quarterly preventive maintenance schedule for the SCA4-1100 A4 production machine.','MAINTENANCE','INTERNAL','RELEASED',1,'sca4-1100-pm-plan.pdf','application/pdf',654210,'machines','["sca4-1100","maintenance"]','MAINTENANCE',false,NULL,interval '90 days'),
  ('DOC-2026-0004','880mm Jumbo Paper Specification','Incoming raw material specification and acceptance criteria for 880mm jumbo paper rolls.','QUALITY','CONFIDENTIAL','APPROVED',1,'jumbo-paper-spec.pdf','application/pdf',389120,'products','["jumbo","specification"]','QMS',false,NULL,interval '180 days'),
  ('DOC-2026-0005','Ream Packaging SOP','Standard operating procedure for ream wrapping, labelling, carton packing and palletisation.','PROCEDURE','INTERNAL','IN_REVIEW',1,'ream-packaging-sop.pdf','application/pdf',512880,'work_orders','["packaging","sop"]','PRODUCTION',false,NULL,interval '14 days'),
  ('DOC-2026-0006','Certificate of Analysis Template','Reusable certificate of analysis template for NATEX A4 finished batches.','CERTIFICATE','INTERNAL','DRAFT',1,'coa-template.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',24832,NULL,'["certificate","template"]','CERTIFICATES',true,NULL,interval '2 days')
) AS v(code, title, description, category, classification, status, version, file_name, file_type, file_size, entity_type, tags, folder, is_template, retention_until, ago)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM dms_documents d WHERE d.tenant_id = t.id AND d.code = v.code);

INSERT INTO dms_versions (tenant_id, document_id, version, file_name, file_type, file_size, change_note, created_by, created_at)
SELECT t.id,
       (SELECT d.id FROM dms_documents d WHERE d.tenant_id = t.id AND d.code = v.code),
       v.version, v.file_name, v.file_type, v.file_size, v.note, u.id, now() - v.ago
FROM tenants t
JOIN users u ON u.tenant_id = t.id AND u.username = 'admin'
CROSS JOIN (VALUES
  ('DOC-2026-0001',1,'natex-a4-production-standard-v1.pdf','application/pdf',812004,'Initial release of the production standard.',interval '160 days'),
  ('DOC-2026-0001',2,'natex-a4-production-standard-v2.pdf','application/pdf',842136,'Updated SCA4-1100 reel tension and moisture settings after validation.',interval '120 days'),
  ('DOC-2026-0002',1,'quality-manual-v1.pdf','application/pdf',1254870,'Initial release of the quality manual.',interval '150 days'),
  ('DOC-2026-0003',1,'sca4-1100-pm-plan.pdf','application/pdf',654210,'Initial release of the PM plan.',interval '90 days'),
  ('DOC-2026-0004',1,'jumbo-paper-spec.pdf','application/pdf',389120,'Initial release of the raw material specification.',interval '180 days'),
  ('DOC-2026-0005',1,'ream-packaging-sop.pdf','application/pdf',512880,'Draft for review by production and QC.',interval '14 days')
) AS v(code, version, file_name, file_type, file_size, note, ago)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM dms_versions dv WHERE dv.document_id = (SELECT d.id FROM dms_documents d WHERE d.tenant_id = t.id AND d.code = v.code) AND dv.version = v.version);

-- Pending review marker for the Ream Packaging SOP
INSERT INTO dms_reviews (tenant_id, document_id, version_id, reviewer_id, action, comment, created_at)
SELECT t.id, d.id, v.id, u.id, 'SUBMITTED', 'Submitted by production for QC and warehouse review.', now() - interval '14 days'
FROM tenants t
JOIN dms_documents d ON d.tenant_id = t.id AND d.code = 'DOC-2026-0005'
JOIN dms_versions v ON v.document_id = d.id AND v.version = 1
JOIN users u ON u.tenant_id = t.id AND u.username = 'admin'
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM dms_reviews r WHERE r.document_id = d.id AND r.action = 'SUBMITTED');
-- ------------------------------------------------------------
-- 10. Seed: document management settings (HDG tenant)
-- ------------------------------------------------------------
INSERT INTO dms_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT t.id, c.id, v.category, v.key, v.value::jsonb,
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1)
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('retention','default_days','{"policy":90,"contract":3650,"quality":1825,"finance":2555,"hr":1825}'),
  ('classification','default','{"default":"INTERNAL","allowed":["PUBLIC","INTERNAL","CONFIDENTIAL","RESTRICTED"]}'),
  ('storage','limits','{"max_bytes":20971520,"allowed_types":["pdf","docx","xlsx","csv","png","jpg","jpeg","zip"]}'),
  ('naming','prefix','{"prefix":"DOC","pad":6}'),
  ('workflow','review','{"require_approval":true,"release_after_approval":false}')
) AS v(category, key, value)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM dms_settings s WHERE s.tenant_id = t.id AND s.company_id = c.id AND s.category = v.category AND s.key = v.key);