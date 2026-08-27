-- ============================================================
-- 0085 Database Management & Data Governance Platform
-- Retention policies, integrity runs, database settings,
-- migration audit + database.* permission set.
-- ============================================================

-- ---------- 1. Database retention policies ----------
CREATE TABLE IF NOT EXISTS db_retention_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  category TEXT NOT NULL,
  retention_days INT NOT NULL DEFAULT 365,
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  applies_to TEXT NOT NULL DEFAULT 'ALL_RECORDS',
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category, applies_to)
);
CREATE INDEX IF NOT EXISTS idx_db_retention_tenant ON db_retention_policies(tenant_id);

-- ---------- 2. Database integrity runs ----------
CREATE TABLE IF NOT EXISTS db_integrity_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  check_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PASS' CHECK (status IN ('PASS','WARNING','FAIL')),
  passed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  warnings INT NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  run_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_db_integrity_tenant ON db_integrity_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_db_integrity_checked ON db_integrity_runs(started_at);

-- ---------- 3. Database settings ----------
CREATE TABLE IF NOT EXISTS db_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_db_settings_tenant ON db_settings(tenant_id);

-- ---------- 4. Migration audit ----------
CREATE TABLE IF NOT EXISTS db_migration_audit (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  migration_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('APPLY','ROLLBACK','VERIFY','REVIEW','APPROVE','SKIP')),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','ROLLED_BACK')),
  duration_ms INT,
  notes TEXT,
  executed_by BIGINT REFERENCES users(id),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_db_migration_audit_tenant ON db_migration_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_db_migration_audit_name ON db_migration_audit(migration_name);

-- ---------- 5. Seed retention policies per tenant ----------
INSERT INTO db_retention_policies (tenant_id, category, retention_days, legal_hold, applies_to, notes)
SELECT t.id, v.category, v.retention_days, v.legal_hold, v.applies_to, v.notes
FROM tenants t
CROSS JOIN (VALUES
  ('AUDIT_LOGS', 2555, true, 'ALL_RECORDS', 'Audit trails retained 7 years; legal hold enabled.'),
  ('FINANCIAL_RECORDS', 3650, true, 'ALL_RECORDS', 'Financial records retained 10 years per Uganda tax record-keeping requirements.'),
  ('OPERATIONAL_LOGS', 90, false, 'ALL_RECORDS', 'Operational logs retained 90 days.'),
  ('QR_TRACEABILITY', 3650, true, 'ALL_RECORDS', 'QR traceability retained 10 years; legal hold enabled.'),
  ('TEMPORARY_FILES', 30, false, 'ALL_RECORDS', 'Temporary files retained 30 days.'),
  ('BACKUP_RECORDS', 365, false, 'ALL_RECORDS', 'Backup records retained 1 year.')
) AS v(category, retention_days, legal_hold, applies_to, notes)
ON CONFLICT (tenant_id, category, applies_to) DO NOTHING;

-- ---------- 6. Seed database settings defaults ----------
INSERT INTO db_settings (tenant_id, key, value)
SELECT t.id, v.key, v.value::jsonb
FROM tenants t
CROSS JOIN (VALUES
  ('storage_warning_pct', '80'),
  ('connection_warning_pct', '85'),
  ('slow_query_ms', '1000'),
  ('backup_encryption', 'true'),
  ('statement_timeout_ms', '15000'),
  ('audit_retention_days', '2555')
) AS v(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ---------- 7. Seed database.* permissions ----------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'database', v.resource, v.action, v.description
FROM (VALUES
  ('database.health.view','health','view','View database health and command center'),
  ('database.connections.view','connections','view','View database connections'),
  ('database.activity.view','activity','view','View database activity and query monitor'),
  ('database.performance.view','performance','view','View database performance metrics'),
  ('database.query.analyze','query','analyze','Analyze query plans and execution history'),
  ('database.schema.view','schema','view','View tables, schemas and relationships'),
  ('database.schema.manage','schema','manage','Manage schema objects'),
  ('database.index.view','index','view','View index insights'),
  ('database.index.manage','index','manage','Create, rebuild or drop indexes'),
  ('database.backup.view','backup','view','View backups'),
  ('database.backup.create','backup','create','Create backups'),
  ('database.backup.delete','backup','delete','Delete backups'),
  ('database.restore.request','restore','request','Request a database restore'),
  ('database.restore.approve','restore','approve','Approve database restores'),
  ('database.migration.view','migration','view','View migration history'),
  ('database.migration.execute','migration','execute','Execute database migrations'),
  ('database.integrity.run','integrity','run','Run data integrity checks'),
  ('database.data_quality.view','data_quality','view','View data quality center'),
  ('database.retention.manage','retention','manage','Manage retention policies'),
  ('database.archive.manage','archive','manage','Manage data archiving'),
  ('database.audit.view','audit','view','View database audit trail'),
  ('database.settings.manage','settings','manage','Manage database settings')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- ---------- 8. Grant database.* to administration roles ----------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code LIKE 'database.%'
WHERE r.code IN ('super_administrator','system_administrator','it_support_administrator','security_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Executive / leadership read-only visibility of database health
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'database.health.view','database.connections.view','database.activity.view',
  'database.performance.view','database.schema.view','database.index.view',
  'database.backup.view','database.migration.view','database.data_quality.view',
  'database.audit.view'
)
WHERE r.code IN ('ceo','executive_director','general_manager','managing_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------- 9. Audit triggers for new tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'db_retention_policies','db_integrity_runs','db_settings','db_migration_audit'
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

-- ---------- 10. Row-level security: tenant isolation ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'db_retention_policies','db_integrity_runs','db_settings','db_migration_audit'
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
