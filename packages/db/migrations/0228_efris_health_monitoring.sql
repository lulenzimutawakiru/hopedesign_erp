-- ============================================================================
-- 0228_efris_health_monitoring.sql
-- Scheduled EFRIS gateway health checks (T101 server-time / OAuth token probe).
--
-- A periodic worker probes every active TEST/ACTIVE configuration with a
-- READ-ONLY call (T101 server time for the URA system-to-system gateway, or an
-- OAuth token request) and records the outcome. This surfaces credential,
-- device-registration and connectivity failures without waiting for a live
-- fiscal document to be rejected. No fiscal document is ever submitted here.
--
-- Offline-enabler (Aisino TCS) configurations hold their device key on the
-- TCS, not the ERP, so they cannot run T101; the worker records them with
-- ok = NULL ("manual verification required") rather than a false failure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS efris_health_checks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  config_id BIGINT NOT NULL REFERENCES efris_configurations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  protocol TEXT,
  host TEXT,
  ok BOOLEAN,
  return_code TEXT,
  message TEXT,
  server_time TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_efris_health_checks_config
  ON efris_health_checks (config_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_efris_health_checks_tenant
  ON efris_health_checks (tenant_id, checked_at DESC);

ALTER TABLE efris_health_checks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'efris_health_checks' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON efris_health_checks USING (tenant_id = app_tenant_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_efris_health_checks') THEN
    CREATE TRIGGER trg_audit_efris_health_checks AFTER INSERT OR UPDATE OR DELETE ON efris_health_checks
      FOR EACH ROW EXECUTE FUNCTION audit_row();
  END IF;
END $$;
