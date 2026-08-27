-- 0076_report_analytics_archive.sql
-- Soft-archive controls for saved report views and schedules, plus a
-- security-definer helper so the scheduler can list due runs across the
-- tenant without exposing tenant-scoped tables to ordinary app queries.

ALTER TABLE report_saved_views ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_rsv_visible ON report_saved_views(user_id, report_name) WHERE is_archived = false;
CREATE INDEX IF NOT EXISTS idx_rsched_visible ON report_schedules(company_id, enabled) WHERE is_archived = false;

-- Scheduler queue read (bypasses tenant RLS so one background job can serve
-- every tenant; per-schedule execution is re-scoped to the schedule tenant).
CREATE OR REPLACE FUNCTION get_due_report_schedules()
RETURNS TABLE (
  id BIGINT,
  tenant_id BIGINT,
  company_id BIGINT,
  created_by BIGINT,
  name TEXT,
  report_name TEXT,
  filters JSONB,
  frequency TEXT,
  run_time TIME,
  day_of_week INTEGER,
  day_of_month INTEGER,
  recipients JSONB,
  enabled BOOLEAN,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, s.tenant_id, s.company_id, s.created_by, s.name, s.report_name,
         s.filters, s.frequency, s.run_time, s.day_of_week, s.day_of_month,
         s.recipients, s.enabled, s.next_run_at, s.last_run_at, s.last_status
  FROM report_schedules s
  WHERE s.enabled AND s.is_archived = false AND s.next_run_at <= now()
  ORDER BY s.next_run_at
  LIMIT 50
$$;
