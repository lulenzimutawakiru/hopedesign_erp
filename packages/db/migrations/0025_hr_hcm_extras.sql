-- ============================================================
-- 0025 HCM - Requisition/Vacancy enrichment + recruitment channel tracking
-- ============================================================

-- Job requisitions: full intake form fields
ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS hiring_manager_id BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS required_qualifications TEXT,
  ADD COLUMN IF NOT EXISTS required_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS experience_years NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS job_description TEXT,
  ADD COLUMN IF NOT EXISTS is_replacement BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS required_date DATE;

-- Vacancies: publication + tracking
ALTER TABLE vacancies
  ADD COLUMN IF NOT EXISTS views_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS applications_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS apply_url TEXT;

-- Per-channel publication + view tracking (internal/external portal, website,
-- configured channels, job boards via integrations)
CREATE TABLE vacancy_channels (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  vacancy_id BIGINT NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL DEFAULT 'INTERNAL_PORTAL'
    CHECK (channel_type IN ('INTERNAL_PORTAL','EXTERNAL_PORTAL','COMPANY_WEBSITE',
                            'JOB_BOARD','SOCIAL','AGENCY','OTHER')),
  provider TEXT,
  url TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  applications INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vacancy_channels_vacancy ON vacancy_channels(vacancy_id);

-- Raw view events for recruitment analytics
CREATE TABLE vacancy_views (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  vacancy_id BIGINT NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  view_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT,
  referrer TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vacancy_views_vacancy_date ON vacancy_views(vacancy_id, view_date);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name IN ('vacancy_channels')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at'
        AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- Row-level security
ALTER TABLE vacancy_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacancy_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vacancy_channels USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON vacancy_views USING (tenant_id = app_tenant_id());

-- DB-level audit triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vacancy_channels','vacancy_views']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
