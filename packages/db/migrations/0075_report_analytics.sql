 -- 0075_report_analytics.sql
 -- Reports & Analytics platform for HOPE DESIGN GROUP LTD Enterprise ERP.
 -- Persists saved report views, scheduled report deliveries and delivery logs.
 -- Every schedule run is scoped to the schedule company and recorded for audit.

 CREATE TABLE IF NOT EXISTS report_saved_views (
   id BIGSERIAL PRIMARY KEY,
   tenant_id BIGINT NOT NULL REFERENCES tenants(id),
   company_id BIGINT REFERENCES companies(id),
   user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   name TEXT NOT NULL,
   report_name TEXT NOT NULL,
   filters JSONB NOT NULL DEFAULT '{}'::jsonb,
   sort JSONB NOT NULL DEFAULT '{}'::jsonb,
   is_default BOOLEAN NOT NULL DEFAULT false,
   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_rsv_user ON report_saved_views(user_id, updated_at DESC);
 CREATE INDEX IF NOT EXISTS idx_rsv_tenant ON report_saved_views(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_rsv_report ON report_saved_views(report_name);
 CREATE UNIQUE INDEX IF NOT EXISTS uq_rsv_user_default ON report_saved_views(user_id, report_name) WHERE is_default;

 CREATE TABLE IF NOT EXISTS report_schedules (
   id BIGSERIAL PRIMARY KEY,
   tenant_id BIGINT NOT NULL REFERENCES tenants(id),
   company_id BIGINT REFERENCES companies(id),
   created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
   name TEXT NOT NULL,
   report_name TEXT NOT NULL,
   filters JSONB NOT NULL DEFAULT '{}'::jsonb,
   frequency TEXT NOT NULL DEFAULT 'DAILY'
     CHECK (frequency IN ('ONCE','DAILY','WEEKLY','MONTHLY')),
   run_time TIME NOT NULL DEFAULT '08:00',
   day_of_week INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
   day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
   recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
   enabled BOOLEAN NOT NULL DEFAULT true,
   next_run_at TIMESTAMPTZ NOT NULL,
   last_run_at TIMESTAMPTZ,
   last_status TEXT,
   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_rsched_due ON report_schedules(next_run_at) WHERE enabled;
 CREATE INDEX IF NOT EXISTS idx_rsched_tenant ON report_schedules(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_rsched_user ON report_schedules(created_by);

 CREATE TABLE IF NOT EXISTS report_deliveries (
   id BIGSERIAL PRIMARY KEY,
   tenant_id BIGINT NOT NULL REFERENCES tenants(id),
   company_id BIGINT REFERENCES companies(id),
   schedule_id BIGINT REFERENCES report_schedules(id) ON DELETE SET NULL,
   created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
   report_name TEXT NOT NULL,
   filters JSONB NOT NULL DEFAULT '{}'::jsonb,
   recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
   status TEXT NOT NULL DEFAULT 'QUEUED'
     CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
   row_count INTEGER NOT NULL DEFAULT 0,
   error TEXT,
   started_at TIMESTAMPTZ,
   finished_at TIMESTAMPTZ,
   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_rdel_sched ON report_deliveries(schedule_id, id DESC);
 CREATE INDEX IF NOT EXISTS idx_rdel_tenant ON report_deliveries(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_rdel_status ON report_deliveries(status);

 DROP TRIGGER IF EXISTS trg_audit ON report_saved_views;
 CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON report_saved_views FOR EACH ROW EXECUTE FUNCTION audit_row();
 DROP TRIGGER IF EXISTS trg_set_updated_at ON report_saved_views;
 CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON report_saved_views FOR EACH ROW EXECUTE FUNCTION set_updated_at();

 DROP TRIGGER IF EXISTS trg_audit ON report_schedules;
 CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON report_schedules FOR EACH ROW EXECUTE FUNCTION audit_row();
 DROP TRIGGER IF EXISTS trg_set_updated_at ON report_schedules;
 CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON report_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

 DROP TRIGGER IF EXISTS trg_audit ON report_deliveries;
 CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON report_deliveries FOR EACH ROW EXECUTE FUNCTION audit_row();

 -- Tenant isolation (defence in depth; the API applies org scope in queries too).
 DO $$
 DECLARE t text;
 BEGIN
   FOREACH t IN ARRAY ARRAY['report_saved_views','report_schedules','report_deliveries']
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
