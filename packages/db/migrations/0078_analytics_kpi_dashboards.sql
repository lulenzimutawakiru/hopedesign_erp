-- 0078_analytics_kpi_dashboards.sql
-- Configurable KPI engine, dashboard builder and custom report builder for
-- the Reports & Analytics platform. Every KPI definition, dashboard and
-- custom report is persisted and scoped to the tenant/company.

-- ---- Configurable KPI definitions ----
CREATE TABLE IF NOT EXISTS analytics_kpis (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  department TEXT,
  owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  data_source TEXT NOT NULL,
  value_column TEXT,
  aggregation TEXT NOT NULL DEFAULT 'SUM'
    CHECK (aggregation IN ('SUM','COUNT','AVG','MAX','MIN')),
  period_column TEXT,
  unit TEXT NOT NULL DEFAULT 'number',
  frequency TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  direction TEXT NOT NULL DEFAULT 'HIGHER_BETTER'
    CHECK (direction IN ('HIGHER_BETTER','LOWER_BETTER')),
  target_value NUMERIC(18,4),
  warning_threshold NUMERIC(18,4),
  critical_threshold NUMERIC(18,4),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_akpi_tenant ON analytics_kpis(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_akpi_company ON analytics_kpis(company_id);

-- ---- Period-specific target overrides ----
CREATE TABLE IF NOT EXISTS analytics_kpi_targets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  kpi_id BIGINT NOT NULL REFERENCES analytics_kpis(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  target_value NUMERIC(18,4) NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_akpit_kpi ON analytics_kpi_targets(kpi_id, period_start, period_end);

-- ---- KPI measurements (actual values + status classification) ----
CREATE TABLE IF NOT EXISTS analytics_kpi_measurements (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  kpi_id BIGINT NOT NULL REFERENCES analytics_kpis(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id),
  period_start DATE,
  period_end DATE,
  actual_value NUMERIC(18,4),
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NO_DATA'
    CHECK (status IN ('EXCELLENT','ON_TARGET','WARNING','CRITICAL','NO_DATA')),
  measured_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_akpim_kpi ON analytics_kpi_measurements(kpi_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_akpim_tenant ON analytics_kpi_measurements(tenant_id);

-- ---- Dashboards ----
CREATE TABLE IF NOT EXISTS analytics_dashboards (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_personal BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adash_visible ON analytics_dashboards(tenant_id, company_id) WHERE is_archived = false;
CREATE INDEX IF NOT EXISTS idx_adash_user ON analytics_dashboards(created_by) WHERE is_personal;

-- ---- Dashboard widgets ----
CREATE TABLE IF NOT EXISTS analytics_dashboard_widgets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  dashboard_id BIGINT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
  widget_type TEXT NOT NULL
    CHECK (widget_type IN ('KPI','CHART','TABLE','REPORT','TREND')),
  title TEXT NOT NULL,
  kpi_id BIGINT REFERENCES analytics_kpis(id) ON DELETE SET NULL,
  report_name TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position JSONB NOT NULL DEFAULT '{}'::jsonb,
  size JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adw_dash ON analytics_dashboard_widgets(dashboard_id);

-- ---- Custom report builder definitions ----
CREATE TABLE IF NOT EXISTS custom_reports (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  data_source TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  visualization TEXT NOT NULL DEFAULT 'table'
    CHECK (visualization IN ('table','bar','line','pie','kpi')),
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crep_visible ON custom_reports(tenant_id, company_id) WHERE is_archived = false;
CREATE INDEX IF NOT EXISTS idx_crep_user ON custom_reports(created_by);

-- ---- Audit + updated-at triggers ----
DROP TRIGGER IF EXISTS trg_audit ON analytics_kpis;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON analytics_kpis FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS trg_set_updated_at ON analytics_kpis;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON analytics_kpis FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_audit ON analytics_kpi_targets;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON analytics_kpi_targets FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit ON analytics_kpi_measurements;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON analytics_kpi_measurements FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit ON analytics_dashboards;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON analytics_dashboards FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS trg_set_updated_at ON analytics_dashboards;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON analytics_dashboards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_audit ON analytics_dashboard_widgets;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON analytics_dashboard_widgets FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS trg_set_updated_at ON analytics_dashboard_widgets;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON analytics_dashboard_widgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_audit ON custom_reports;
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON custom_reports FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS trg_set_updated_at ON custom_reports;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON custom_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- Tenant isolation (defence in depth; API applies org scope too) ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'analytics_kpis','analytics_kpi_targets','analytics_kpi_measurements',
    'analytics_dashboards','analytics_dashboard_widgets','custom_reports'
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