-- ============================================================
-- 0240 Intelligence — AI lead discovery & prospect database
-- ============================================================
-- Natex Intelligence: discovery campaigns, prospect database, explainable
-- lead scoring and human-reviewed CRM conversion. Reuses the existing CRM
-- model (customers / contacts / leads / opportunities) — prospects are a new
-- upstream pool that flows into CRM only after a human approves them.
--
-- Provider credentials are NOT stored here: they live in the environment
-- (DEEPSEEK_API_KEY, SEARCH_PROVIDER, ...) and are read by the service layer.
-- The default search provider is a deterministic sandbox connector.

CREATE TABLE discovery_campaigns (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','PAUSED','COMPLETED','ARCHIVED')),
  -- Targeting criteria: { query, industries[], countries[], regions[], cities[],
  --                        keywords[], minEmployees, maxEmployees, ... }
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Schedule: { enabled: boolean, everyMs: integer }. When enabled the discovery
  -- worker ticks due campaigns and advances next_run_at.
  schedule JSONB NOT NULL DEFAULT '{"enabled": false, "everyMs": 86400000}'::jsonb,
  owner_user_id BIGINT,
  max_results INTEGER NOT NULL DEFAULT 50 CHECK (max_results BETWEEN 1 AND 500),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX idx_discovery_campaigns_status ON discovery_campaigns(status);

CREATE TABLE prospects (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  campaign_id BIGINT REFERENCES discovery_campaigns(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  industry TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  employees_min INTEGER,
  employees_max INTEGER,
  revenue_min NUMERIC(18,2),
  revenue_max NUMERIC(18,2),
  source_provider TEXT NOT NULL DEFAULT 'sandbox',
  source_query TEXT,
  source_rank INTEGER,
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','REVIEWED','APPROVED','REJECTED','CONVERTED','DISCARDED')),
  -- Explainable score out of 100 (section H). score_factors is a JSON array of
  -- { key, label, points, max, detail } so every point is attributable.
  score INTEGER,
  score_version INTEGER NOT NULL DEFAULT 1,
  score_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Duplicate detection (section J): link, never auto-merge.
  duplicate_of BIGINT REFERENCES prospects(id) ON DELETE SET NULL,
  duplicate_score NUMERIC(6,4),
  -- extracted = website intelligence output (deterministic). ai = AI engine
  -- output (industryClass, icpFit, rationale, buyingSignals, tags, source).
  -- raw = provider payload (marked synthetic for the sandbox connector).
  extracted JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  converted_customer_id BIGINT,
  converted_lead_id BIGINT,
  converted_at TIMESTAMPTZ,
  reviewed_by BIGINT,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX idx_prospects_campaign ON prospects(campaign_id);
CREATE INDEX idx_prospects_status ON prospects(status);
CREATE INDEX idx_prospects_industry ON prospects(industry);
CREATE INDEX idx_prospects_score ON prospects(company_id, score DESC);
CREATE INDEX idx_prospects_website ON prospects(company_id, website);
CREATE INDEX idx_prospects_name ON prospects(company_id, name);

-- ============================================================================
-- RLS + triggers (tenant isolation, updated_at, audit)
-- ============================================================================
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['discovery_campaigns','prospects'] LOOP
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
