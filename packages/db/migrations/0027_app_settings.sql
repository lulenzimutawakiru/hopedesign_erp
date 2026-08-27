-- ============================================================
-- 0027 App settings - tenant/company-scoped key/value preferences
-- Backs the Administration > Settings module (admin.settings.*)
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_app_settings_tenant_category ON app_settings(tenant_id, category);

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at'
      AND tgrelid = 'app_settings'::regclass
  ) THEN
    CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON app_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Row-level security (tenant isolation matches every other tenant table)
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON app_settings USING (tenant_id = app_tenant_id());
  END IF;
END $$;

-- DB-level audit trigger (row changes are captured with old/new values)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = 'app_settings'::regclass
  ) THEN
    CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON app_settings
      FOR EACH ROW EXECUTE FUNCTION audit_row();
  END IF;
END $$;

-- Seed defaults for the demo tenant/company (idempotent)
-- Values are stored as JSONB; strings must be quoted JSON literals.
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT 2, 2, x.category, x.key, x.value::jsonb, NULL
FROM (VALUES
  ('general',       'company_name',              '"Hope Design Group Ltd"'),
  ('general',       'currency',                  '"UGX"'),
  ('general',       'timezone',                  '"Africa/Kampala"'),
  ('general',       'low_stock_threshold',       '5'),
  ('security',      'password_min_length',       '8'),
  ('security',      'session_timeout_minutes',   '30'),
  ('notifications', 'low_stock_alerts',          'true'),
  ('notifications', 'approval_reminders',        'true'),
  ('qr',            'qr_prefix',                 '"HDG"'),
  ('qr',            'qr_verify_url',             '"https://verify.hopedesign.co.ug/verify"'),
  ('quality',       'qc_auto_block_on_fail',     'true'),
  ('documents',     'retention_days',            '1825')
) AS x(category, key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings s
  WHERE s.tenant_id = 2 AND s.company_id = 2
    AND s.category = x.category AND s.key = x.key
);
